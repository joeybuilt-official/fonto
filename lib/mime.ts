// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// MIME fingerprinting for uploads where the client-supplied Content-Type is
// unreliable (`application/octet-stream`, blank, or just plain wrong). We
// sniff the first ~4KiB of the buffer with `file-type` and also recognize
// the camera-RAW formats that `file-type` doesn't always cover (CR3, ARW,
// NEF, etc.) via filename extension as a fallback.
//
// The goal is narrow: keep `assets.mimeType` honest so the downstream
// thumbnail/decoder dispatcher (lib/processing/decode.ts) can route to the
// correct backend. We do NOT try to be a full magic-number library.

import { fileTypeFromBuffer } from "file-type";

/**
 * Canonical mime types we map to for camera RAW formats. We use the
 * "image/x-vendor-format" convention that exiftool and most desktop OSes
 * follow; these don't all have IANA-registered media types.
 */
export const RAW_MIME_TYPES = new Set<string>([
  "image/x-canon-cr2",
  "image/x-canon-cr3",
  "image/x-adobe-dng",
  "image/x-sony-arw",
  "image/x-nikon-nef",
  "image/x-nikon-nrw",
  "image/x-panasonic-rw2",
  "image/x-olympus-orf",
  "image/x-fuji-raf",
  "image/x-pentax-pef",
  "image/x-samsung-srw",
  "image/x-sigma-x3f",
]);

/**
 * Extension → canonical RAW mime mapping. Used as a fallback when the magic
 * sniffer doesn't recognize the container (CR3/ARW are TIFF-derived; file-type
 * sometimes labels them as image/tiff or won't identify them).
 */
const RAW_EXT_MIME: Record<string, string> = {
  cr2: "image/x-canon-cr2",
  cr3: "image/x-canon-cr3",
  dng: "image/x-adobe-dng",
  arw: "image/x-sony-arw",
  srf: "image/x-sony-arw",
  sr2: "image/x-sony-arw",
  nef: "image/x-nikon-nef",
  nrw: "image/x-nikon-nrw",
  rw2: "image/x-panasonic-rw2",
  raw: "image/x-panasonic-rw2",
  orf: "image/x-olympus-orf",
  raf: "image/x-fuji-raf",
  pef: "image/x-pentax-pef",
  srw: "image/x-samsung-srw",
  x3f: "image/x-sigma-x3f",
};

/**
 * Extension → canonical HEIC mime mapping. Browsers/Safari pass
 * "image/heic" reliably for iPhone uploads but Finder drag-drop on macOS
 * sometimes sends application/octet-stream.
 */
const HEIC_EXT_MIME: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
  hif: "image/heif",
  avif: "image/avif",
};

/**
 * Extension → text/code mime mapping. `file-type` only sniffs binary magic
 * numbers, so plain-text files (notes, markdown, source) come back
 * unidentified and otherwise fall through to octet-stream. Camera-roll
 * imports often arrive with a generic mime, so we recover these by extension.
 */
const TEXT_EXT_MIME: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  py: "text/x-python",
};

export function isRawMime(mimeType: string): boolean {
  return RAW_MIME_TYPES.has(mimeType.toLowerCase());
}

/**
 * E4-M6 — mimes whose RAW original must NOT be handed to an ML consumer
 * (CLIP embedder / VLM) directly. These containers are not decodable by the
 * vision model from the original bytes — feeding the original made the VLM
 * confabulate a generic scene and the embedder fail — so they may only go
 * through the sharp-decoded preview derivative (`previewKey`, produced when
 * `thumbnail_state='ready'`).
 *
 * Raw camera formats (`isRawMime`) plus HEIC/HEIF/AVIF. Everything else the
 * pipeline treats as image/ (JPEG, PNG, WebP, GIF, BMP, TIFF, …) decodes from
 * the original, so those keep the `previewKey ?? original` fallback.
 */
export function visionNeedsPreview(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  if (isRawMime(m)) return true;
  return m === "image/heic" || m === "image/heif" || m === "image/avif";
}

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * Determine the canonical mime + extension for an upload. Strategy:
 *   1. If the client-supplied mime is specific and trustworthy (anything
 *      other than empty/`application/octet-stream`), keep it — but still try
 *      to derive an extension for downstream tools.
 *   2. Otherwise, sniff the buffer with `file-type` (reads the first
 *      ~4KiB; safe on any size buffer).
 *   3. If the sniffer punts, fall back to the filename extension for the
 *      RAW + HEIC formats we explicitly support.
 *   4. Last resort: return the client mime (or `application/octet-stream`).
 *
 * Never throws; corrupt/empty buffers just return `application/octet-stream`.
 */
export async function detectMime(
  buffer: Buffer | Uint8Array,
  clientMime: string,
  filename: string
): Promise<{ mimeType: string; ext: string }> {
  const ext = extensionOf(filename);
  const trimmedClient = (clientMime || "").trim().toLowerCase();
  const clientIsGeneric =
    !trimmedClient ||
    trimmedClient === "application/octet-stream" ||
    trimmedClient === "binary/octet-stream";

  // Honour a specific client mime — they're usually right and re-sniffing
  // every image on upload adds latency we don't need.
  if (!clientIsGeneric) {
    return { mimeType: trimmedClient, ext };
  }

  // Magic-number sniff. file-type recognises JPEG/PNG/HEIC/AVIF/TIFF/etc.
  try {
    const ft = await fileTypeFromBuffer(buffer);
    if (ft?.mime) {
      // file-type returns `image/heic`, `image/heif`, etc. directly.
      return { mimeType: ft.mime, ext: ft.ext || ext };
    }
  } catch {
    // fall through to extension fallback
  }

  // Extension fallback for the formats file-type can't pin down (notably
  // most camera RAW containers).
  if (ext && RAW_EXT_MIME[ext]) {
    return { mimeType: RAW_EXT_MIME[ext], ext };
  }
  if (ext && HEIC_EXT_MIME[ext]) {
    return { mimeType: HEIC_EXT_MIME[ext], ext };
  }
  if (ext && TEXT_EXT_MIME[ext]) {
    return { mimeType: TEXT_EXT_MIME[ext], ext };
  }

  return { mimeType: trimmedClient || "application/octet-stream", ext };
}
