// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
/**
 * Classify a terminal thumbnail-generation failure reason as PERMANENT — the
 * source bytes will produce the exact same failure on every future retry, so
 * the row belongs in `thumbnail_state='skipped'` — or as a genuine failure
 * worth retrying (`thumbnail_state='failed'`).
 *
 * `'failed'` means "might succeed on retry". Writing it for a class that
 * never will is exactly what caused the endless-retry loops fixed
 * 2026-09-08 (see docs/claude/worklog.md, `fix(storage+thumbnails)`, which
 * did the same reclassification for unsupported mime types). This function
 * is the single place that decision gets made — extend it here, not at a
 * call site, whenever a new permanently-undecodable class is diagnosed.
 *
 * Every pattern below was verified against real production files before
 * being added (Phase C1, 2026-09-09 — see docs/claude/worklog.md for the
 * evidence per class: header-vs-file-size mismatch for truncated PSDs,
 * three independent RAW decoders rejecting the same CR2 bytes, etc).
 *
 * Pure: no imports beyond types, no I/O, no framework. Safe to call from
 * any layer, and independently testable with no worker/DB/subprocess.
 */

interface PermanentSignature {
  /** Human label for the class — documentation only, not matched on. */
  readonly label: string;
  readonly pattern: RegExp;
}

const PERMANENT_SIGNATURES: readonly PermanentSignature[] = [
  // decodeToBuffer's own "no decoder for this mime at all" throw — the
  // 2026-09-08 EPS/BMP precedent this function generalizes.
  { label: "unsupported-mime", pattern: /unsupported mime type/i },

  // decodeRawWithDcraw's combined-failure message, built only after LibRaw's
  // embedded-preview stage AND its full-demosaic stage both threw a
  // non-timeout error AND the sharp "misidentified RAW" probe also failed to
  // read a usable image. Deterministic for a given file — includes the
  // already-decided-against JPEG-XR DNG gap (message contains "jxrlib";
  // 2026-08-30/31 expert panel rejected adding jxrlib) and any RAW file none
  // of LibRaw/sharp can identify at all.
  { label: "raw-exhausted", pattern: /raw decode failed for/i },

  // libjpeg/libvips fatal JPEG stream errors. Every sharp() call site in
  // generateThumbnails.ts already sets `failOn: "none"` (max leniency); these
  // are the errors libvips still throws at that leniency because the header
  // or entropy-coded data itself is unrecoverable — not a lenient-mode
  // warning that a stricter/looser flag could route around.
  { label: "corrupt-jpeg", pattern: /VipsJpeg:/i },

  // decodePsdWithFfmpeg exhausted all three stages (ffmpeg composite,
  // ImageMagick composite, embedded Photoshop-thumbnail resource) and got
  // zero bytes from every one.
  { label: "psd-exhausted", pattern: /psd decode produced no output/i },
  // ...or the last-resort exiftool stage itself errored rather than merely
  // returning empty stdout — a malformed resource block, same root cause.
  {
    label: "psd-exiftool-error",
    pattern: /exiftool exited \d+: Error: File format error/i,
  },

  // ffmpeg's demuxer can't find the box that carries the sample table — the
  // container is truncated, not merely hard to decode.
  { label: "truncated-mp4", pattern: /moov atom not found/i },

  // libtiff dropped support for pre-TIFF6 ("old-style") JPEG compression
  // decades ago; no CLI flag re-enables it. Verified 2026-09-09: LibRaw
  // (simple_dcraw, dcraw_emu) and ImageMagick's own RAW delegate all reject
  // these files outright too — three independent tools agree it isn't RAW
  // data they can read, not just a libvips gap.
  {
    label: "old-style-jpeg-tiff",
    pattern: /Old-style JPEG compression support is not configured/i,
  },

  // poppler's own parser rejected the file — deterministic given fixed
  // invocation args (page 1, fixed dpi), whether the cause is a password or
  // a broken xref/trailer.
  { label: "pdf-rejected", pattern: /pdftoppm exit \d+:/i },

  // A single physically huge PDF page (e.g. poster-format print art)
  // rendered at the fixed thumbnail DPI exceeds sharp's decompression-bomb
  // ceiling. `unlimited: true` deliberately does NOT lift this one (see the
  // doc comment on `encodeVariant` in generateThumbnails.ts) — it's a
  // guard, not a bug, and it's deterministic for this file at this DPI.
  { label: "oversized-pdf-page", pattern: /Input image exceeds pixel limit/i },
];

export function isPermanentThumbnailFailure(reason: string): boolean {
  return PERMANENT_SIGNATURES.some(({ pattern }) => pattern.test(reason));
}
