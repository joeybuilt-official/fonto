// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Pure classification override helpers — shared by the live processAsset
// pipeline and the one-shot classify-only backfill script. Lives in its own
// module (rather than processAsset.ts) so scripts can import the helpers
// without dragging in the Plexo SDK + S3 client + sharp + webhook + memory
// modules that processAsset.ts pulls at top-level.

// Screenshots were being mislabeled as documents/scans by the classifier.
// Detect them deterministically: a filename that mentions "screenshot", or a
// PNG whose aspect ratio matches a phone-portrait (~9:16–9:21) or desktop 16:9
// display. When matched we force classification to "screenshot".
// Filename markers used by iOS / Android / Pixel / Samsung / 3rd-party tools.
const SCREENSHOT_NAME_RE =
  /screenshot|screen.?shot|^scrnli|^screen[_-]?recording/i;

export function isScreenshot(
  filename: string,
  mimeType: string,
  widthPx: number | null,
  heightPx: number | null,
): boolean {
  if (SCREENSHOT_NAME_RE.test(filename)) return true;
  // Aspect-ratio heuristic. Phone screenshots ARE saved as JPEG too (iOS
  // "Save to Files", Drive re-encodes PNG → JPEG on import), so the PNG-only
  // gate from the original heuristic was missing every Drive-imported phone
  // capture. Apply to any image mime; the camera-EXIF gate below catches
  // false positives on real photos that happen to be 9:16.
  if (mimeType.startsWith("image/") && widthPx && heightPx) {
    const ar = widthPx / heightPx;
    // Modern phone screens span 9:16 (~0.5625) through 9:21+ (~0.43). Drop
    // the lower bound a hair to cover the Pixel 9 Pro Fold inner display
    // and other foldables (1280×2856 ≈ 0.448).
    const portraitScreen = ar >= 0.40 && ar <= 0.66;
    // 16:9 / 16:10 desktop captures. Widening to 1.55 catches MacBook 16:10
    // (2560×1600 = 1.6) and Surface (1.5).
    const landscapeScreen = ar >= 1.55 && ar <= 1.85;
    if (portraitScreen || landscapeScreen) return true;
  }
  return false;
}

// Real camera captures (any device — phone, DSLR, mirrorless, drone, action
// cam) carry exposure metadata that screenshots NEVER have: shutter speed,
// f-stop, ISO, focal length, or a lens model string. cameraMake alone is
// not enough — iOS / Android stamp the device make on screenshots too. Use
// this to decide whether the screenshot override should fire OR to confirm a
// `kind='moment'` outside the documented screenshot/document/video buckets.
export interface CameraEvidence {
  exposureTime?: string | null;
  fNumber?: number | null;
  iso?: number | null;
  focalLength?: number | null;
  lensModel?: string | null;
}

// Phase 7.2 — OCR-driven document detection. CLIP/LLM often misses phone
// photos of receipts/documents because the hand-holding-paper composition
// pulls the classifier toward "photo". OCR is the deciding signal: real
// documents (receipts, IDs, forms, signs, screenshotted text, etc.) yield
// substantial AND diverse text. Guard against the repeat-loop garbage we
// see in some Drive imports ("AdministratorAdministrator…" 600× chars) by
// requiring at least 12 distinct alphanumeric words ≥ 2 chars.
export function isDocumentByOcr(ocrText: string | null): boolean {
  if (!ocrText) return false;
  if (ocrText.length < 100) return false;
  const tokens = ocrText.toLowerCase().match(/[a-z0-9][a-z0-9'$.,/-]*/g) ?? [];
  const distinct = new Set(tokens.filter((t) => t.length >= 2));
  return distinct.size >= 12;
}

export function hasRealCameraSignals(exif: CameraEvidence): boolean {
  return Boolean(
    (exif.exposureTime !== null && exif.exposureTime !== undefined && exif.exposureTime !== "") ||
      (exif.fNumber !== null && exif.fNumber !== undefined && exif.fNumber > 0) ||
      (exif.iso !== null && exif.iso !== undefined && exif.iso > 0) ||
      (exif.focalLength !== null && exif.focalLength !== undefined && exif.focalLength > 0) ||
      (exif.lensModel !== null && exif.lensModel !== undefined && exif.lensModel !== ""),
  );
}

// Phase 7.3 — Drive imports systematically strip EXIF on transfer, so the
// EXIF-only positive-evidence rule false-negatives real camera photos that
// landed in the library via Google Drive. Filenames mostly survive, and
// camera apps + DSLRs / drones / action cams use very predictable naming:
//
//   iOS         IMG_<4-7 digits>.{HEIC,JPG,MOV}
//   Android     IMG_<yyyymmdd>_<hhmmss>{_HDR,_BURST*}.jpg
//   Pixel       PXL_<yyyymmdd>_<hhmmssmmm>.jpg / MVIMG_*  / .MP.jpg
//   Android pano PANO_<yyyymmdd>_<...>.jpg
//   Samsung     YYYYMMDD_HHMMSS.jpg
//   DSLR        DSC_<4-5 digits>.{JPG,NEF,CR2}, IMG_<4-5 digits>, _DSC<n>, _MG_<n>
//   GoPro       GOPR<digits>.{JPG,MP4}, GP<*>
//   DJI / drone DJI_<digits>_<n>.{JPG,DNG,MOV}
//   Generic vid VID_<...>.{mp4,mov}
//
// Plus mimetypes that are inherently real-camera: HEIC / HEIF / raw formats.
//
// Drive's import wrapper prefixes "drive_<google_id>_" — strip it before
// matching. Avoids false-positives on cached/proxy filenames like
// "drive_..._p_<sha>_<sha>_v7.jpg" (Snapchat / messenger derivative caches)
// + synthetic ids like "drive_..._<long_id>_account_id=1.jpg".
const DRIVE_PREFIX_RE = /^drive_[A-Za-z0-9_-]+_/;
const CAMERA_ROLL_NAME_RE =
  /^(IMG_\d{3,}|MVIMG_\d{8}|PXL_\d{8}|PANO_\d{8}|VID_\d{8}|\d{8}_\d{6}|DSC[_-]?\d{3,}|_DSC\d{3,}|_MG_\d{3,}|GOPR\d{3,}|GP[FH]?\d{3,}|DJI_\d{3,}|MAH\d{5,}|HDR_\d{8})\b/i;

function hasCameraRollFilename(filename: string): boolean {
  const stripped = filename.replace(DRIVE_PREFIX_RE, "");
  return CAMERA_ROLL_NAME_RE.test(stripped);
}

const RAW_OR_HEIC_MIME_RE =
  /^image\/(heic|heif|x-canon-cr[23]|x-nikon-nef|x-sony-arw|x-adobe-dng|x-panasonic-rw2|x-olympus-orf|x-fuji-raf|x-pentax-pef|x-sigma-x3f)$/i;

function isCameraOriginalMime(mimeType: string): boolean {
  return RAW_OR_HEIC_MIME_RE.test(mimeType);
}

// Combined positive-evidence test. Use this instead of `hasRealCameraSignals`
// when deciding whether to demote a `classification='photo'` to screenshot —
// it adds two safety nets that recover Drive-stripped real photos (filename
// pattern) and inherent-camera formats (HEIC/RAW) that EXIF alone misses.
export function looksLikeCameraPhoto(
  filename: string,
  mimeType: string,
  exif: CameraEvidence,
): boolean {
  return (
    hasRealCameraSignals(exif) ||
    hasCameraRollFilename(filename) ||
    isCameraOriginalMime(mimeType)
  );
}

// Phase 7.2 — OCR-based "this image is OF paper" detection. Phone shots of
// receipts / packing slips / handwritten notes / invoices carry real camera
// EXIF, so the positive-evidence rule would route them to Moments. But OCR
// sees dense text that real moments never have. Cheap heuristic: enough
// text + document keywords OR money-density. Only DEMOTES photo→document;
// never promotes a moment that isn't already photo-classified (would over-
// fire on photos of signs / packaging that aren't really docs).
const DOC_KEYWORD_RE =
  /\b(receipt|invoice|order\s*#|order\s*number|sub\s?total|subtotal|tax|tip\s*amt?|amount\s+due|paid|cash|credit\s*card|debit|visa|mastercard|amex|tracking|tracking\s*#|packing\s*slip|ship\s*to|return\s*address|sold\s*to|bill\s*to|customer\s*#|account\s*#|sku|qty|quantity|due\s*date|po\s*#|p\.o\.|terms|signature|page\s+\d+\s+of\s+\d+|dear\s+sir|dear\s+madam|sincerely|to\s+whom\s+it\s+may\s+concern)\b/i;

export function ocrLooksLikePaperDocument(ocr: string | null): boolean {
  if (!ocr) return false;
  const text = ocr.trim();
  if (text.length < 120) return false;
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 4) return false;
  if (DOC_KEYWORD_RE.test(text)) return true;
  // Receipts have a stack of $nn.nn lines. Money density + line count is a
  // second-tier signal when the keyword regex misses.
  const moneyHits = (text.match(/[$€£¥]\s?\d+[.,]\d{2}\b/g) ?? []).length;
  if (moneyHits >= 2 && lines.length >= 6) return true;
  return false;
}
