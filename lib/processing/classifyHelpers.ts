// SPDX-License-Identifier: MIT
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

// Filename signal ONLY (trusted: a "Screenshot..." name is intentional). Used
// by deriveKind to force screenshot ahead of the OCR-document heuristic.
export function isScreenshotByName(filename: string): boolean {
  return SCREENSHOT_NAME_RE.test(filename);
}

// Aspect-ratio signal ONLY (shape, NOT content). Phone screenshots ARE saved
// as JPEG too (iOS "Save to Files", Drive re-encodes PNG → JPEG on import),
// so the PNG-only gate from the original heuristic was missing every
// Drive-imported phone capture. Apply to any image mime. NOTE: shape ≠
// content — an EXIF-stripped tall PHOTO matches this too, so deriveKind no
// longer forces screenshot on this signal alone (operator policy 2026-06-10).
export function isScreenshotByAspect(
  mimeType: string,
  widthPx: number | null,
  heightPx: number | null,
): boolean {
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

// Back-compat union (name OR aspect). Kept for call sites that still want the
// combined signal; deriveKind + the processAsset override use the split
// helpers above so the aspect signal can't force screenshot on its own.
export function isScreenshot(
  filename: string,
  mimeType: string,
  widthPx: number | null,
  heightPx: number | null,
): boolean {
  return (
    isScreenshotByName(filename) ||
    isScreenshotByAspect(mimeType, widthPx, heightPx)
  );
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

// Lower-bar OCR signal: "this image carries enough text to look like a meme,
// captioned graphic, social-share screenshot, or chat clip — definitely not
// a candid camera moment." Used by deriveKind to demote photo→graphics when
// the classifier defaulted to 'photo' (low CLIP confidence + LLM fallback)
// but the image has overlay text AND lacks any positive camera evidence.
//
// Threshold tuning: 40+ chars + 5+ distinct alphanumeric tokens ≥ 2 chars.
// Single-word signs ("STOP", "EXIT") in real-world photos don't trip this.
// Real camera photos with text gate out at the looksLikeCameraPhoto check
// in deriveKind before this fires, so a wedding-sign or street-scene photo
// stays a moment.
export function hasOverlayText(ocrText: string | null): boolean {
  if (!ocrText) return false;
  if (ocrText.length < 40) return false;
  const tokens = ocrText.toLowerCase().match(/[a-z0-9][a-z0-9'$.,/-]*/g) ?? [];
  const distinct = new Set(tokens.filter((t) => t.length >= 2));
  return distinct.size >= 5;
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

// ADR 0001 §6 — Whiteboard heuristic. False-positive risk = white-walled
// rooms; mitigated by requiring real OCR token density. CLIP already gets
// most flat-on whiteboards via the new prompt; this catches the angle-of-
// repose cases (whiteboard photographed from a meeting seat) AND the
// people-in-front cases the panel called out in §7 conflict #3.
//
// Two thresholds:
//   - Bare-whiteboard (no people in frame): 3 distinct alphanumeric tokens
//     is enough — matches the §6 dominant-white-BG gate spec.
//   - People-in-front (classifier returned portrait/event): 5 distinct
//     tokens, per panel acceptance for §7 conflict #3. People + low OCR
//     means it's a meeting photo, not a whiteboard capture.
//
// The classifier returning classification="whiteboard" is an automatic pass
// regardless of OCR (CLIP already grounded on the whiteboard prompt; OCR is
// belt-and-suspenders for that path).
const WHITEBOARD_FILENAME_RE = /whiteboard|white.?board|wb[_-]?\d+/i;
const TOKEN_RE = /[a-z0-9][a-z0-9'$.,/-]*/gi;

function distinctOcrTokens(ocr: string | null): number {
  if (!ocr) return 0;
  const matches = ocr.toLowerCase().match(TOKEN_RE) ?? [];
  const distinct = new Set(matches.filter((t) => t.length >= 2));
  return distinct.size;
}

export interface WhiteboardCaptureInput {
  widthPx: number | null;
  heightPx: number | null;
  filename: string;
  classification: string | null;
  subClassification: string | null;
  ocrText: string | null;
}

export function isWhiteboardCapture(args: WhiteboardCaptureInput): boolean {
  const { widthPx, heightPx, filename, classification, subClassification, ocrText } = args;
  // CLIP already said it's a whiteboard — trust that. The top-level "whiteboard"
  // legacy key and the new document/whiteboard sub both qualify.
  if (classification === "whiteboard") return true;
  if (subClassification === "whiteboard") return true;

  const tokens = distinctOcrTokens(ocrText);
  // People-in-front override (panel §7 conflict #3 — ≥5 tokens).
  // Portrait/event/selfie + dense OCR = whiteboard behind people.
  if (
    tokens >= 5 &&
    (classification === "portrait" ||
      classification === "photo" ||
      classification === "event" ||
      subClassification === "portrait" ||
      subClassification === "event" ||
      subClassification === "selfie")
  ) {
    return true;
  }

  // Bare-whiteboard heuristic (§6, ≥3 tokens): filename hint + reasonable
  // aspect ratio. Whiteboards are 4:3 — 16:10ish, never tall portrait.
  if (tokens < 3) return false;
  if (!widthPx || !heightPx) return false;
  const ar = widthPx / heightPx;
  const whiteboardAspect = ar >= 1.0 && ar <= 1.9; // 1:1 through 16:8.4
  if (!whiteboardAspect) return false;
  // Require either filename hint OR doc-y context (the classifier landed
  // somewhere text-adjacent but not on document yet — note/handwritten-note/
  // form/report sub-classifications point here from a near miss).
  const filenameHint = WHITEBOARD_FILENAME_RE.test(filename);
  const docContext =
    classification === "document" ||
    classification === "note" ||
    subClassification === "handwritten-note" ||
    subClassification === "note-page" ||
    subClassification === "form" ||
    subClassification === "report";
  return filenameHint || docContext;
}

// ADR 0001 §6 — Photo-of-art override. classification=art + EXIF + no OCR
// tokens means "I stood in a museum and snapped this painting." Per §7
// conflict #4, default-to-moment when classification=art + EXIF regardless
// of OCR (placard text is fine to ignore — frame-coverage detection isn't
// worth 200ms/asset).
//
// Simplification from spec: we ignore the "OCR finds 0 meaningful tokens"
// gate entirely. The panel said "default to moment when classification=art
// + EXIF, regardless of OCR (use isPhotoOfArt). Document the simplification."
// — done. If a real placard-with-painting case slips through to moment, fine;
// the operator's mental model is "I was there".
export interface PhotoOfArtInput {
  classification: string | null;
  exif: CameraEvidence;
  ocrText: string | null;
}

export function isPhotoOfArt(args: PhotoOfArtInput): boolean {
  const { classification, exif } = args;
  if (classification !== "art") return false;
  return hasRealCameraSignals(exif);
}
