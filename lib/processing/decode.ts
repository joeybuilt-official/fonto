// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Decoder dispatcher — normalize "anything photo-shaped" into a buffer that
// `sharp` can read. The thumbnail generator (Phase 1.1) calls
// `decodeToBuffer()` before pipelining the bytes through sharp; if we can
// decode it here, the rest of the pipeline doesn't have to know whether the
// original was a JPEG, an iPhone HEIC, or a Canon CR3.
//
// Dispatch table (input mime → backend):
//
//   image/jpeg, image/png, image/webp, image/gif, image/tiff
//                                          → passthrough (sharp native)
//   image/avif                              → passthrough (libvips/heif)
//   image/heic, image/heif, image/heic-sequence
//                                          → sharp if libheif present,
//                                            else `heif-convert` subprocess
//   image/x-canon-cr2 | -cr3 | -adobe-dng | -sony-arw | -nikon-nef | ...
//   (any mime in lib/mime.RAW_MIME_TYPES)   → `simple_dcraw -e <file>` for
//                                            the embedded preview; fall back
//                                            to `dcraw_emu -w -T <file>`
//                                            (TIFF from raw sensor data).
//   image/vnd.adobe.photoshop               → `ffmpeg -i <file> -frames:v 1`
//                                            (ffmpeg's psd decoder renders
//                                            the flattened composite)
//
// Subprocesses run with a hard timeout (RAW_DECODE_TIMEOUT_MS, default 30s);
// killed processes throw a clear error that the caller can surface as a
// thumbnail failure without retrying forever.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { logger } from "@/lib/logger";
import { isRawMime, extensionOf } from "@/lib/mime";

export interface DecodedImage {
  /** PNG/JPEG/TIFF buffer that `sharp(buffer)` can immediately read. */
  buffer: Buffer;
  /**
   * Tag describing which backend produced the output, for logging /
   * metrics. e.g. "passthrough", "heic", "cr2-embedded-jpeg",
   * "dng-dcraw-tiff", "heif-convert".
   */
  sourceFormat: string;
}

const RAW_DECODE_TIMEOUT_MS = Number(
  process.env.RAW_DECODE_TIMEOUT_MS ?? 30_000
);

/**
 * Mimes that sharp / libvips handles natively without any pre-decode.
 * libvips has had HEIC read support since 8.10 (we ship 8.17 via the
 * prebuilt sharp binary as of 2026-05); we still feature-detect at boot
 * to handle Alpine builds where libheif might be stripped.
 */
const PASSTHROUGH_MIMES = new Set<string>([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/avif",
  // sharp's bundled libvips rasterises SVG natively (verified), so the raw
  // bytes pass straight through to the encoder like any other web image.
  "image/svg+xml",
]);

const HEIC_MIMES = new Set<string>([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

const PSD_MIMES = new Set<string>([
  "image/vnd.adobe.photoshop",
  "image/x-photoshop",
]);

// ─── Capability detection (run once at module load) ─────────────────────────

/**
 * Diagnostic only — `true` if `sharp.format` reports an input-capable `heif`
 * codec. NOTE: this does NOT imply sharp can actually decode iPhone HEIC: the
 * prebuilt binary's bundled libheif lacks the HEVC (libde265) decoder plugin,
 * so HEVC-compressed HEIC fails at encode time. We therefore always decode
 * HEIC via the system `heif-convert` regardless of this flag (see
 * decodeToBuffer). Kept for capability logging / metrics.
 */
const SHARP_HAS_HEIF: boolean = (() => {
  try {
    const heif = sharp.format.heif;
    return Boolean(heif?.input?.buffer);
  } catch {
    return false;
  }
})();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Normalize an input buffer to something sharp can read. Pass-through for
 * the common web formats; subprocess decode for RAW; libheif-or-fallback
 * for HEIC.
 *
 * Throws on:
 *   - unsupported mime types (caller should record an unprocessable thumb)
 *   - subprocess timeout (RAW_DECODE_TIMEOUT_MS exceeded)
 *   - subprocess non-zero exit AND no fallback produced output
 *
 * Does NOT swallow errors silently — the thumbnail generator is the policy
 * layer; the decoder just reports honestly what happened.
 */
export async function decodeToBuffer(
  input: Buffer,
  mimeType: string,
  filename: string
): Promise<DecodedImage> {
  const mime = mimeType.toLowerCase();

  if (PASSTHROUGH_MIMES.has(mime)) {
    return { buffer: input, sourceFormat: "passthrough" };
  }

  if (HEIC_MIMES.has(mime)) {
    // Always route HEIC through the system `heif-convert` (libheif + libde265).
    // sharp's prebuilt binary reports `format.heif.input` but its BUNDLED
    // libheif ships without the HEVC decoder plugin — iPhone HEIC is HEVC, so
    // sharp passthrough fails with "Support for this compression format has
    // not been built in", silently leaving the asset thumbnail-less (and the
    // VLM then confabulates from the raw bytes → "sunset" mislabels). The
    // system heif-convert HAS the libde265 plugin and decodes these correctly.
    return decodeWithHeifConvert(input, filename);
  }

  if (isRawMime(mime)) {
    return decodeRawWithDcraw(input, mime, filename);
  }

  if (PSD_MIMES.has(mime)) {
    return decodePsdWithFfmpeg(input, filename);
  }

  throw new Error(`decodeToBuffer: unsupported mime type ${mimeType}`);
}

/**
 * Capability probe used by callers that want to render a graceful UI
 * fallback ("preview not available") rather than throwing. Doesn't actually
 * decode anything.
 */
export function canDecode(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return (
    PASSTHROUGH_MIMES.has(mime) ||
    HEIC_MIMES.has(mime) ||
    isRawMime(mime) ||
    PSD_MIMES.has(mime)
  );
}

export const __decoderCapabilities = {
  sharpHasHeif: SHARP_HAS_HEIF,
  rawDecodeTimeoutMs: RAW_DECODE_TIMEOUT_MS,
};

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Decode a HEIC/HEIF buffer using the libheif `heif-convert` CLI tool. Used
 * only when sharp/libvips wasn't built with HEIF input. Writes input to a
 * tempfile, runs `heif-convert in.heic out.png`, reads the PNG back.
 */
async function decodeWithHeifConvert(
  input: Buffer,
  filename: string
): Promise<DecodedImage> {
  const ext = extensionOf(filename) || "heic";
  const dir = await mkdtemp(join(tmpdir(), "fonto-heic-"));
  const inPath = join(dir, `in.${ext}`);
  const outPath = join(dir, "out.png");
  try {
    await writeFile(inPath, input);
    await runSubprocess("heif-convert", [inPath, outPath], RAW_DECODE_TIMEOUT_MS);
    const out = await readFile(outPath);
    if (out.length === 0) {
      throw new Error("heif-convert produced empty output");
    }
    return { buffer: out, sourceFormat: "heif-convert" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Decode a camera RAW file using LibRaw's CLI samples. Two-stage:
 *   1. `simple_dcraw -e <file>` — extract the embedded preview into
 *      `<file>.thumb.jpg` (or `.thumb.ppm` for cameras that embed an
 *      uncompressed preview). Most cameras embed a full-resolution JPEG;
 *      this is what the camera's LCD shows and what Lightroom uses for the
 *      "Embedded" preview. Fast (~50ms) and high quality.
 *      NOTE: dcraw_emu does NOT accept classic dcraw's `-e`/`-c` flags (its
 *      `-c` is a float threshold) — thumbnail extraction lives in
 *      simple_dcraw, and output always goes to files, never stdout.
 *   2. If that fails (no embedded preview / corrupt / unsupported), fall
 *      back to `dcraw_emu -w -T -Z <out> <file>` which demosaics the raw
 *      sensor data to a TIFF. Slower (~1-3s per shot) but always works for
 *      LibRaw-supported cameras.
 *   3. If LibRaw rejects the file outright ("Unsupported file format or not
 *      RAW file"), it probably never was RAW: every camera RAW container we
 *      list is TIFF-derived, so the magic sniffer confuses the two in both
 *      directions (see lib/mime.RAW_EXT_MIME) and a plain scanner TIFF can
 *      land here. Probe the ORIGINAL bytes with sharp/libvips — if it reads
 *      them, hand them back as a passthrough tagged `-misidentified-raw` so
 *      the recovery is visible in logs instead of failing the asset.
 *
 * Files we touch live in a per-invocation tempdir that's removed in finally.
 */
async function decodeRawWithDcraw(
  input: Buffer,
  mime: string,
  filename: string
): Promise<DecodedImage> {
  const ext = extensionOf(filename) || rawExtFromMime(mime) || "raw";
  const dir = await mkdtemp(join(tmpdir(), "fonto-raw-"));
  const inPath = join(dir, `in.${ext}`);
  try {
    await writeFile(inPath, input);

    // Stage 1: embedded preview → <inPath>.thumb.jpg / .thumb.ppm.
    let embeddedError = "no embedded preview";
    try {
      await runSubprocess("simple_dcraw", ["-e", inPath], RAW_DECODE_TIMEOUT_MS);
      for (const thumbPath of [`${inPath}.thumb.jpg`, `${inPath}.thumb.ppm`]) {
        const embedded = await readFile(thumbPath).catch(() => null);
        if (embedded && embedded.length > 0) {
          return {
            buffer: embedded,
            sourceFormat: `${rawTagFromMime(mime)}-embedded-jpeg`,
          };
        }
      }
    } catch (err) {
      // Stage 2 will retry; only re-throw timeouts (no point demosaicing if
      // the file's pathologically large).
      if (err instanceof Error && err.message.includes("timed out")) {
        throw err;
      }
      embeddedError = errorMessage(err);
    }

    // Stage 2: full demosaic to TIFF.
    let demosaicError: string;
    try {
      const outPath = join(dir, "out.tiff");
      await runSubprocess(
        "dcraw_emu",
        ["-w", "-T", "-Z", outPath, inPath],
        RAW_DECODE_TIMEOUT_MS
      );
      const tiff = await readFile(outPath).catch(() => null);
      if (!tiff || tiff.length === 0) {
        throw new Error(`dcraw_emu produced no output for ${filename}`);
      }
      return { buffer: tiff, sourceFormat: `${rawTagFromMime(mime)}-dcraw-tiff` };
    } catch (err) {
      demosaicError = errorMessage(err);
    }

    // Stage 3: LibRaw says this isn't RAW — believe it, and let sharp try the
    // original bytes. Header read only (`metadata()`), so a misidentified
    // 400MB scanner TIFF doesn't cost a second full-size copy in the worker
    // heap; the caller re-reads the same buffer with the same sharp options.
    try {
      const meta = await sharp(input, {
        failOn: "none",
        unlimited: true,
      }).metadata();
      if (!meta.width || !meta.height) {
        throw new Error("sharp read no image dimensions");
      }
      logger.info(
        {
          filename,
          mime,
          sharpFormat: meta.format,
          width: meta.width,
          height: meta.height,
        },
        "decoded as misidentified RAW: dcraw rejected the file, sharp read it"
      );
      return {
        buffer: input,
        sourceFormat: `${rawTagFromMime(mime)}-misidentified-raw`,
      };
    } catch (err) {
      throw new Error(
        `raw decode failed for ${filename} (${mime}): ` +
          `simple_dcraw: ${embeddedError}; dcraw_emu: ${demosaicError}; ` +
          `sharp fallback: ${errorMessage(err)}`
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Decode a Photoshop PSD to PNG. Two-stage:
 *   1. ffmpeg's psd decoder renders the flattened composite (present in
 *      any PSD saved with "Maximize Compatibility"). Fast, but its RLE
 *      reader rejects some real-world PSDs ("Invalid rle char").
 *   2. ImageMagick `magick <in>[0] <out>` — the reference PSD reader;
 *      `[0]` selects the merged composite. Slower but handles the RLE
 *      variants ffmpeg chokes on.
 *   3. `exiftool -b -PhotoshopThumbnail` — the ~160px JPEG Photoshop embeds
 *      as an image resource. Last resort for damaged/truncated PSDs (the
 *      library holds file-carve recoveries whose layer data is gone but
 *      whose resource block survived). Low-res, but enough for a library
 *      thumbnail and classification; the original stays for download.
 * PSDs run big (largest in the library is 220MB, ~9s via ffmpeg at idle),
 * so the timeout gets a 60s floor regardless of the RAW knob.
 */
async function decodePsdWithFfmpeg(
  input: Buffer,
  filename: string
): Promise<DecodedImage> {
  const ext = extensionOf(filename) || "psd";
  const dir = await mkdtemp(join(tmpdir(), "fonto-psd-"));
  const inPath = join(dir, `in.${ext}`);
  const outPath = join(dir, "out.png");
  const timeoutMs = Math.max(RAW_DECODE_TIMEOUT_MS, 60_000);
  try {
    await writeFile(inPath, input);
    try {
      await runSubprocess(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, "-frames:v", "1", outPath],
        timeoutMs
      );
      const out = await readFile(outPath).catch(() => null);
      if (out && out.length > 0) {
        return { buffer: out, sourceFormat: "psd-ffmpeg" };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        throw err;
      }
    }
    try {
      await runSubprocess("magick", [`${inPath}[0]`, outPath], timeoutMs);
      const out = await readFile(outPath).catch(() => null);
      if (out && out.length > 0) {
        return { buffer: out, sourceFormat: "psd-magick" };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        throw err;
      }
    }
    const thumb = await runSubprocessCaptureStdout(
      "exiftool",
      ["-b", "-PhotoshopThumbnail", inPath],
      timeoutMs
    );
    if (thumb.length === 0) {
      throw new Error(`psd decode produced no output for ${filename}`);
    }
    return { buffer: thumb, sourceFormat: "psd-embedded-thumbnail" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rawTagFromMime(mime: string): string {
  // image/x-canon-cr3 → "cr3"
  const m = /^image\/x-[^-]+-([a-z0-9]+)$/i.exec(mime);
  return m?.[1]?.toLowerCase() ?? "raw";
}

function rawExtFromMime(mime: string): string | undefined {
  const tag = rawTagFromMime(mime);
  return tag === "raw" ? undefined : tag;
}

/**
 * Spawn `cmd` with `args`, capture stdout as a Buffer, enforce a hard
 * timeout. Throws on non-zero exit, stderr is included in the error message.
 */
async function runSubprocessCaptureStdout(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn ${cmd} failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").slice(0, 500);
        reject(new Error(`${cmd} exited ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Spawn a subprocess that writes its output to a file (not stdout); we just
 * wait for it to exit successfully. Same timeout semantics as
 * `runSubprocessCapture`.
 */
async function runSubprocess(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn ${cmd} failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").slice(0, 500);
        reject(new Error(`${cmd} exited ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}
