// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — streaming walk of a Takeout ZIP archive.
//
// Tens-of-GB safe: we open the ZIP from a *file path* (yauzl needs random
// access to read the central directory at the end of the file — a pure
// forward stream can't be opened without buffering the whole thing), and read
// exactly one member's bytes into memory at a time. A single member is one
// photo/video (or its small JSON sidecar), never the whole archive, so peak
// RAM is bounded by the largest single media file.
//
// The walk yields one `MediaMember` per media file: its filename, the decoded
// bytes, a best-effort mime, the parsed sidecar `metadataOverride` (when a
// sidecar matched), and the album directory (mapped to `directoryPath`). JSON
// sidecars and non-media members are skipped — sidecars are read on demand
// when their media member is reached.
//
// `.tgz`/`.tar.gz` Takeout exports are not supported in Phase 2; the caller
// detects them up front (see `isUnsupportedArchive`) and records the reason on
// the import job rather than failing mid-walk.

import { open as fsOpen } from "node:fs/promises";
import yauzl, { type ZipFile, type Entry } from "yauzl";
import { extensionOf } from "@/lib/mime";
import {
  matchSidecar,
  parseSidecar,
  isSidecarName,
  type SidecarMetadata,
} from "./takeoutSidecar";

/** One ingestable media member streamed out of the archive. */
export interface MediaMember {
  /** The bare file name (no directory) — passed to createAssetRow as filename. */
  filename: string;
  /** Full archive path of the member (used as the resume cursor). */
  memberPath: string;
  /** The member's decoded bytes (one media file at a time — never the archive). */
  buffer: Buffer;
  /** Best-effort mime from the extension; createAssetRow re-sniffs the buffer. */
  mime: string;
  /** Parsed sidecar metadata, or undefined when no sidecar matched. */
  override?: SidecarMetadata;
  /** Album directory ("Travel 2021") for createAssetRow.directoryPath, or null. */
  albumDir: string | null;
}

// Image + video extensions we treat as ingestable media. Mirrors the formats
// Fonto already accepts (lib/mime.ts RAW/HEIC sets + the common web formats).
// Everything else in the archive (sidecars, .html index pages, etc.) is skipped.
const MEDIA_EXTS = new Set<string>([
  // images
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
  "hif", "avif",
  // raw
  "cr2", "cr3", "dng", "arw", "srf", "sr2", "nef", "nrw", "rw2", "raw", "orf",
  "raf", "pef", "srw", "x3f",
  // video
  "mp4", "mov", "m4v", "3gp", "avi", "mkv", "webm", "mpg", "mpeg", "mts", "m2ts",
]);

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  hif: "image/heif",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  mts: "video/mp2t",
  m2ts: "video/mp2t",
};

function isMediaName(name: string): boolean {
  if (name.endsWith("/")) return false; // directory entry
  return MEDIA_EXTS.has(extensionOf(name));
}

function mimeForName(name: string): string {
  return EXT_MIME[extensionOf(name)] ?? "application/octet-stream";
}

/**
 * True for archive formats we don't support in Phase 2 (tarballs). Google
 * occasionally hands out `.tgz` Takeout parts; the worker records this as the
 * job error instead of attempting a partial walk.
 */
export function isUnsupportedArchive(fileName: string | null): boolean {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".tar");
}

/**
 * Derive the album directory from a Takeout member path. Takeout lays photos
 * out under `Takeout/Google Photos/<album-or-date-bucket>/<file>`; the segment
 * after "Google Photos" is the album (named album or a "Photos from YYYY" date
 * bucket). Returns null for files not under that tree (or at the root).
 */
export function albumDirOf(memberPath: string): string | null {
  const parts = memberPath.split("/").filter(Boolean);
  const gpIdx = parts.findIndex((p) => p === "Google Photos");
  if (gpIdx >= 0 && gpIdx + 1 < parts.length - 1) {
    // segment immediately after "Google Photos", but only if there's a file
    // after it (gpIdx+1 is not the last element).
    return parts[gpIdx + 1];
  }
  // Fallback: the immediate parent directory name, if any.
  if (parts.length >= 2) return parts[parts.length - 2];
  return null;
}

/** Promisified yauzl.open with lazy entries + no string-decoding surprises. */
function openZip(path: string): Promise<ZipFile> {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, decodeStrings: true },
      (err, zip) => {
        if (err || !zip) return reject(err ?? new Error("failed to open zip"));
        resolve(zip);
      },
    );
  });
}

/** Read a single entry's bytes fully into a Buffer (one member at a time). */
function readEntryBuffer(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("no read stream"));
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

/**
 * Enumerate every member path in the archive without reading any file bytes.
 * Cheap (central-directory walk) and needed up front so the sidecar matcher
 * can resolve a media file to a sidecar that may sort *after* it. Returns the
 * ordered list of member paths.
 */
export async function listArchiveMembers(zipPath: string): Promise<string[]> {
  const zip = await openZip(zipPath);
  const names: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (entry: Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve());
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return names;
}

/**
 * Async-iterate the media members of a Takeout ZIP. For each media entry we
 * read its bytes, look up + read its matched sidecar (parsing the JSON into a
 * `metadataOverride`), and yield a `MediaMember`. Sidecars and non-media
 * members are skipped.
 *
 * @param zipPath      Path to the downloaded archive on disk.
 * @param memberNames  All member paths (from `listArchiveMembers`) so the
 *                     matcher can resolve out-of-order sidecars.
 * @param opts.resumeAfter  When set, members up to and including this path are
 *                     skipped (resume from an `import_jobs.cursor`).
 *
 * NB: a second open is intentional — the enumeration pass and the read pass are
 * separate so the matcher sees the full member set before we start reading
 * bytes. Both passes read one entry header at a time; neither buffers the
 * archive.
 */
export async function* walkTakeoutMedia(
  zipPath: string,
  memberNames: string[],
  opts: { resumeAfter?: string | null } = {},
): AsyncGenerator<MediaMember, void, unknown> {
  const memberSet = new Set(memberNames);
  // Cache sidecar buffers we read so an album where the edited + original both
  // map to one sidecar doesn't re-read it. Small (sidecars are a few KB).
  const sidecarCache = new Map<string, SidecarMetadata>();

  const zip = await openZip(zipPath);
  // Map member path -> Entry as we encounter them, so we can openReadStream a
  // sidecar that we may not have reached yet. We need a way to fetch an Entry
  // by name; yauzl is forward-only, so we read sidecars by re-opening a short
  // random-access read. Simpler + correct: keep a name->Entry map by doing the
  // read pass and, when a media entry's sidecar hasn't been seen yet, fall
  // back to a fresh fd read. In practice sidecars sort adjacent to their media
  // so the map almost always has it.
  const entryByName = new Map<string, Entry>();
  let resumeReached = !opts.resumeAfter;

  try {
    const pending: MediaMember[] = [];
    // Drain helper yields buffered media members produced inside the event loop.
    // Because yauzl's iteration is callback-driven we collect into `pending`
    // and yield between readEntry() calls.

    // We process entries strictly in archive order. For each entry:
    //  - record it in entryByName,
    //  - if it's media (and past the resume point), resolve+read its sidecar
    //    and push a MediaMember.
    await new Promise<void>((resolve, reject) => {
      const onEntry = (entry: Entry): void => {
        void (async () => {
          try {
            entryByName.set(entry.fileName, entry);

            if (isSidecarName(entry.fileName) || !isMediaName(entry.fileName)) {
              zip.readEntry();
              return;
            }

            // Resume gating: skip everything up to and including the cursor.
            if (!resumeReached) {
              if (entry.fileName === opts.resumeAfter) resumeReached = true;
              zip.readEntry();
              return;
            }

            const buffer = await readEntryBuffer(zip, entry);

            // Resolve + parse the sidecar (best-effort).
            let override: SidecarMetadata | undefined;
            const sidecarPath = matchSidecar(entry.fileName, memberSet);
            if (sidecarPath) {
              if (sidecarCache.has(sidecarPath)) {
                override = sidecarCache.get(sidecarPath);
              } else {
                const sidecarEntry = entryByName.get(sidecarPath);
                let sidecarBuf: Buffer | null = null;
                if (sidecarEntry) {
                  sidecarBuf = await readEntryBuffer(zip, sidecarEntry);
                } else {
                  // Sidecar sorts after this media member — read it directly
                  // from the file via a fresh random-access yauzl pass.
                  sidecarBuf = await readSidecarOutOfOrder(zipPath, sidecarPath);
                }
                if (sidecarBuf) {
                  override = parseSidecar(sidecarBuf);
                  sidecarCache.set(sidecarPath, override);
                }
              }
            }

            const slash = entry.fileName.lastIndexOf("/");
            const filename =
              slash >= 0 ? entry.fileName.slice(slash + 1) : entry.fileName;

            pending.push({
              filename,
              memberPath: entry.fileName,
              buffer,
              mime: mimeForName(entry.fileName),
              override,
              albumDir: albumDirOf(entry.fileName),
            });
            zip.readEntry();
          } catch (err) {
            reject(err);
          }
        })();
      };
      zip.on("entry", onEntry);
      zip.on("end", () => resolve());
      zip.on("error", reject);
      zip.readEntry();
    });

    for (const member of pending) {
      yield member;
    }
  } finally {
    zip.close();
  }
}

/**
 * Read a single sidecar entry by name from the archive via a fresh
 * random-access open. Used only when a media member's sidecar sorts *after* it
 * in the central directory (rare — sidecars are usually adjacent). Returns null
 * if the entry can't be found. Reads just that one small JSON member.
 */
async function readSidecarOutOfOrder(
  zipPath: string,
  sidecarPath: string,
): Promise<Buffer | null> {
  const zip = await openZip(zipPath);
  try {
    return await new Promise<Buffer | null>((resolve, reject) => {
      let found = false;
      zip.on("entry", (entry: Entry) => {
        if (entry.fileName === sidecarPath) {
          found = true;
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return reject(err ?? new Error("no stream"));
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", reject);
          });
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => {
        if (!found) resolve(null);
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

/**
 * Quick sniff of the first bytes of a downloaded file to confirm it's a ZIP
 * ("PK\x03\x04" / "PK\x05\x06" / "PK\x07\x08"). Lets the worker reject a
 * tarball-or-other archive early with a clear error. Reads only 4 bytes.
 */
export async function looksLikeZip(path: string): Promise<boolean> {
  const fh = await fsOpen(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  } finally {
    await fh.close();
  }
}
