// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// EXIF / IPTC / XMP extraction for image assets at ingest time.
//
// Wraps `exifr` and reduces its (very wide) output down to the columns the
// `assets` table actually persists. Tolerant of missing or corrupt metadata —
// returns an all-nulls result rather than throwing, so a bad header can never
// block an upload.

import exifr from "exifr";

export interface ExifData {
  /** Raw exifr merged output, kept verbatim for forensic / future-use queries. */
  raw: Record<string, unknown> | null;
  /** Capture timestamp lifted from EXIF (DateTimeOriginal, then CreateDate). */
  capturedAt: Date | null;
  /** Decimal degrees, WGS-84. exifr already handles N/S/E/W sign conversion. */
  latitude: number | null;
  longitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  /** Effective focal length in millimetres. */
  focalLength: number | null;
  /** F-number (e.g. 2.8). */
  fNumber: number | null;
  iso: number | null;
  /** Exposure time as the EXIF-style fractional/decimal string ("1/250"). */
  exposureTime: string | null;
  /** EXIF orientation tag, 1..8. */
  orientation: number | null;
  widthPx: number | null;
  heightPx: number | null;
}

const EMPTY: ExifData = {
  raw: null,
  capturedAt: null,
  latitude: null,
  longitude: null,
  cameraMake: null,
  cameraModel: null,
  lensModel: null,
  focalLength: null,
  fNumber: null,
  iso: null,
  exposureTime: null,
  orientation: null,
  widthPx: null,
  heightPx: null,
};

/**
 * MIME types exifr can decode. Everything else short-circuits to all-nulls;
 * we don't even pay the parse overhead. PDFs, plain text, video, etc.
 *
 * exifr accepts JPEG / TIFF / HEIC / HEIF / AVIF / PNG / WebP / GIF /
 * many RAW formats. We allow-list the common ones rather than blocking by
 * the (much longer) deny-list.
 */
function isExtractable(mimeType: string): boolean {
  if (!mimeType) return false;
  if (!mimeType.startsWith("image/")) return false;
  // Skip vector / synthetic formats that never carry EXIF.
  if (mimeType === "image/svg+xml") return false;
  return true;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n == null ? null : Math.trunc(n);
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Format ExposureTime (commonly a small float like 0.004) back to the
 * conventional "1/250" string photographers expect. Long exposures (≥0.5s)
 * stay as decimals.
 */
function formatExposureTime(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  const n = toNum(v);
  if (n == null || n <= 0) return null;
  if (n >= 0.5) return `${Number(n.toFixed(3))}`;
  const denom = Math.round(1 / n);
  return `1/${denom}`;
}

/**
 * Extract EXIF / IPTC / XMP from an image buffer.
 *
 * Never throws — corrupt headers, unsupported codecs, or empty buffers all
 * resolve to an all-nulls ExifData. The caller does not need a try/catch.
 */
export async function extractExif(
  buffer: Buffer,
  mimeType: string
): Promise<ExifData> {
  if (!isExtractable(mimeType)) return EMPTY;
  if (!buffer || buffer.length === 0) return EMPTY;

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = (await exifr.parse(buffer, {
      // Merge every segment into one flat object; cheaper than juggling
      // per-segment sub-objects downstream.
      mergeOutput: true,
      // Pull GPS, IPTC, XMP in addition to the default TIFF/EXIF blocks.
      gps: true,
      iptc: true,
      xmp: true,
      icc: false,
      // Translate raw tag numbers to readable keys ("Make", "ISO", ...).
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      // Strip vendor maker-notes — these are huge, mostly opaque, and bloat
      // the jsonb column for no real benefit.
      makerNote: false,
      userComment: true,
      sanitize: true,
    })) as Record<string, unknown> | undefined;
  } catch (err) {
    // Bad/corrupt headers throw here. Swallow and return empty — uploads
    // must not fail just because EXIF couldn't be read.
    console.warn("[fonto] exif parse failed:", err);
    return EMPTY;
  }

  if (!parsed) return EMPTY;

  const capturedAt =
    toDate(parsed.DateTimeOriginal) ??
    toDate(parsed.CreateDate) ??
    toDate(parsed.ModifyDate) ??
    null;

  // exifr's `gps: true` + `mergeOutput: true` lifts decimal latitude /
  // longitude onto the top-level object (already signed for N/S/E/W).
  const latitude = toNum(parsed.latitude);
  const longitude = toNum(parsed.longitude);

  // PixelXDimension / PixelYDimension are the canonical EXIF "decoded image
  // size" tags; ImageWidth / ImageHeight are TIFF-side and usually agree.
  const widthPx =
    toInt(parsed.ExifImageWidth) ??
    toInt(parsed.PixelXDimension) ??
    toInt(parsed.ImageWidth) ??
    null;
  const heightPx =
    toInt(parsed.ExifImageHeight) ??
    toInt(parsed.PixelYDimension) ??
    toInt(parsed.ImageHeight) ??
    null;

  return {
    raw: parsed,
    capturedAt,
    latitude:
      latitude != null && latitude >= -90 && latitude <= 90 ? latitude : null,
    longitude:
      longitude != null && longitude >= -180 && longitude <= 180
        ? longitude
        : null,
    cameraMake: toStr(parsed.Make),
    cameraModel: toStr(parsed.Model),
    lensModel: toStr(parsed.LensModel) ?? toStr(parsed.Lens),
    focalLength: toNum(parsed.FocalLength),
    fNumber: toNum(parsed.FNumber) ?? toNum(parsed.ApertureValue),
    iso: toInt(parsed.ISO) ?? toInt(parsed.ISOSpeedRatings),
    exposureTime: formatExposureTime(parsed.ExposureTime),
    orientation: toInt(parsed.Orientation),
    widthPx,
    heightPx,
  };
}
