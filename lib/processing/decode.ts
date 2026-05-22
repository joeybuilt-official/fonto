// SPDX-License-Identifier: AGPL-3.0-only
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
//   (any mime in lib/mime.RAW_MIME_TYPES)   → `dcraw_emu -e -c <file>` for
//                                            embedded JPEG; fall back to
//                                            `dcraw_emu -w -c <file>` (TIFF
//                                            from raw sensor data) on miss.
//
// Subprocesses run with a hard timeout (RAW_DECODE_TIMEOUT_MS, default 30s);
// killed processes throw a clear error that the caller can surface as a
// thumbnail failure without retrying forever.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
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
]);

const HEIC_MIMES = new Set<string>([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

// ─── Capability detection (run once at module load) ─────────────────────────

/**
 * `true` if `sharp.format` reports an input-capable `heif` codec — meaning
 * the bundled libvips was linked against libheif and HEIC files can be
 * decoded directly via `sharp(buffer)`. If false we fall back to the
 * `heif-convert` CLI (libheif tools); if THAT's missing too the decoder
 * throws a clear error.
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
    if (SHARP_HAS_HEIF) {
      return { buffer: input, sourceFormat: "heic-sharp" };
    }
    return decodeWithHeifConvert(input, filename);
  }

  if (isRawMime(mime)) {
    return decodeRawWithDcraw(input, mime, filename);
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
    PASSTHROUGH_MIMES.has(mime) || HEIC_MIMES.has(mime) || isRawMime(mime)
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
    const { readFile } = await import("node:fs/promises");
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
 * Decode a camera RAW file using dcraw_emu (libraw). Two-stage:
 *   1. Try `dcraw_emu -e -c <file>` — extract the embedded preview JPEG.
 *      Most cameras embed a full-resolution JPEG; this is what the camera's
 *      LCD shows and what Lightroom uses for the "Embedded" preview. Fast
 *      (~50ms) and high quality.
 *   2. If that fails (no embedded JPEG / corrupt / unsupported), fall back
 *      to `dcraw_emu -w -c <file>` which demosaics the raw sensor data and
 *      writes a 16-bit TIFF. Slower (~1-3s per shot) but always works for
 *      LibRaw-supported cameras.
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

    // Stage 1: embedded JPEG. dcraw_emu writes to stdout with `-c`.
    try {
      const embedded = await runSubprocessCapture(
        "dcraw_emu",
        ["-e", "-c", inPath],
        RAW_DECODE_TIMEOUT_MS
      );
      if (embedded.length > 0) {
        return {
          buffer: embedded,
          sourceFormat: `${rawTagFromMime(mime)}-embedded-jpeg`,
        };
      }
    } catch (err) {
      // Stage 2 will retry; only re-throw timeouts (no point demosaicing if
      // the file's pathologically large).
      if (err instanceof Error && err.message.includes("timed out")) {
        throw err;
      }
    }

    // Stage 2: full demosaic to TIFF.
    const tiff = await runSubprocessCapture(
      "dcraw_emu",
      ["-w", "-c", inPath],
      RAW_DECODE_TIMEOUT_MS
    );
    if (tiff.length === 0) {
      throw new Error(`dcraw_emu produced no output for ${filename}`);
    }
    return { buffer: tiff, sourceFormat: `${rawTagFromMime(mime)}-dcraw-tiff` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
async function runSubprocessCapture(
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
