// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M12 / ADR 0014 — Android (Google / Samsung) Motion Photo extraction.
//
// A "motion photo" on Android is a JPEG with a short MP4 clip APPENDED after
// the image's EOI marker. Two pointer conventions exist in the wild:
//
//   • GCamera:MicroVideoOffset="N"  (older "MicroVideo") — N = number of bytes
//     from EOF back to the start of the embedded MP4 (i.e. the clip length).
//   • Container:Directory           (MotionPhoto v1) — an XMP RDF list whose
//     video Item carries Length (+ Padding).
//
// Parsing XMP robustly across Google vs Samsung vs MotionPhoto-v1 is brittle,
// so the CONTRACT here is the encoder-agnostic byte scan: find the trailing
// MP4 `ftyp` box (the unambiguous start-of-MP4 marker) that appears AFTER the
// JPEG EOI, and treat everything from that box to EOF as the clip. The
// MicroVideoOffset XMP value is used as a fast-path hint and validated against
// the same `ftyp` check before it's trusted.
//
// No re-encode: the embedded MP4 is already a playable H.264/HEVC stream; the
// caller byte-copies the slice out. The original JPEG is never modified.

const JPEG_SOI = 0xffd8; // start of image
const JPEG_EOI = Buffer.from([0xff, 0xd9]); // end of image
const FTYP = Buffer.from("ftyp", "latin1");
// An ftyp box is tiny in practice (brand list of a few entries). Bound the
// box-size sanity check so a coincidental "ftyp" inside the JPEG entropy data
// doesn't get mistaken for the real box header.
const MIN_FTYP_BOX = 8;
const MAX_FTYP_BOX = 4096;
// A motion clip below this is almost certainly a false positive / truncated.
const MIN_CLIP_BYTES = 1024;

export interface MotionExtraction {
  /** Byte offset of the embedded MP4's first box within the source buffer. */
  offset: number;
  /** Length in bytes of the embedded MP4 (offset → EOF). */
  length: number;
}

/**
 * Locate the MP4 clip embedded in an Android motion photo. Returns its
 * {offset, length} within `buf`, or null when the file is not a motion photo
 * (no trailing MP4 after the JPEG EOI). Pure — no IO, no mutation.
 *
 * `buf` should be the FULL original bytes (JPEG + appended MP4). Pass the XMP
 * region (or the whole file) and the MicroVideoOffset fast-path is used when
 * present; otherwise the byte scan runs.
 */
export function findEmbeddedMotionVideo(buf: Buffer): MotionExtraction | null {
  // Must start with a JPEG SOI — motion photos are always JPEG stills.
  if (buf.length < 4 || buf.readUInt16BE(0) !== JPEG_SOI) return null;

  // Fast path: GCamera:MicroVideoOffset (or the Micro Video namespace variant).
  // The value is the clip's byte length measured back from EOF.
  const micro = readMicroVideoOffset(buf);
  if (micro != null && micro >= MIN_CLIP_BYTES && micro < buf.length) {
    const offset = buf.length - micro;
    if (looksLikeMp4Start(buf, offset)) {
      return { offset, length: micro };
    }
  }

  // Contract path: find the first JPEG EOI, then the first valid `ftyp` box
  // header after it. Anchoring on `ftyp` (not on EOI alone) sidesteps the
  // embedded-EXIF-thumbnail FF D9 ambiguity.
  const eoi = buf.indexOf(JPEG_EOI);
  if (eoi < 0) return null;
  let from = eoi + 2;
  for (;;) {
    const ftyp = buf.indexOf(FTYP, from);
    if (ftyp < 4) return null;
    const boxStart = ftyp - 4;
    const boxSize = buf.readUInt32BE(boxStart);
    if (
      boxStart >= eoi + 2 &&
      boxSize >= MIN_FTYP_BOX &&
      boxSize <= MAX_FTYP_BOX &&
      boxStart + boxSize <= buf.length
    ) {
      const length = buf.length - boxStart;
      if (length >= MIN_CLIP_BYTES) return { offset: boxStart, length };
    }
    from = ftyp + 4;
  }
}

/** True when bytes at `offset` look like the start of an MP4 (`....ftyp`). */
function looksLikeMp4Start(buf: Buffer, offset: number): boolean {
  if (offset < 0 || offset + 8 > buf.length) return false;
  const boxSize = buf.readUInt32BE(offset);
  if (boxSize < MIN_FTYP_BOX || boxSize > MAX_FTYP_BOX) return false;
  return buf.subarray(offset + 4, offset + 8).equals(FTYP);
}

/**
 * Pull the MicroVideoOffset value out of the XMP packet, if present. Scans
 * only the head of the file (XMP lives in an APP1 segment near the top) to
 * avoid loading megabytes of entropy data as a string. Returns the byte count
 * or null.
 */
function readMicroVideoOffset(buf: Buffer): number | null {
  // XMP is ASCII and sits in the first ~256 KiB; cap the slice we stringify.
  const head = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString("latin1");
  const m =
    head.match(/MicroVideoOffset="(\d+)"/) ??
    head.match(/MicroVideoOffset>(\d+)</);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
