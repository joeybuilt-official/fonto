// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Task 20 — KIND: the library's primary partition (lens-based library).
//
// KIND is a thin DETERMINISTIC layer on top of `assets.classification` +
// `mimeType` — NOT a new ML task (see ADR 0001 D1). It collapses the
// fine-grained taxonomy into the small, stable set the library lenses key
// off. Resolved in the one place classification is written
// (`lib/processing/processAsset.ts`) and cached into `assets.kind`.
//
// v1 ships five KINDs: moment / screenshot / graphics / document / video.
// "Saved" (downloaded non-photos that aren't logos/icons/etc.) is deferred —
// ADR D5: not cleanly derivable yet, operator explicitly rejected kind=saved.
//
// ADR 0001 (2026-06-08) — intent-driven 10-rule priority order. §4 of the
// spec is the source of truth; key invariant per Sara:
//
//   "Document classifications IGNORE EXIF; graphics classifications REQUIRE
//   no EXIF. That asymmetry is intentional and must be tested."
//
// Reflected in rules 3 (document beats EXIF) vs rule 6 (graphics requires
// !looksLikeCameraPhoto).

import {
  looksLikeCameraPhoto,
  isScreenshotByName,
  isWhiteboardCapture,
  isPhotoOfArt,
  ocrLooksLikePaperDocument,
  hasOverlayText,
} from "../processing/classifyHelpers";

export const KIND = ["moment", "screenshot", "graphics", "document", "video"] as const;
export type Kind = (typeof KIND)[number];

export function isKind(value: string): value is Kind {
  return (KIND as readonly string[]).includes(value);
}

// Deterministic text/code classification straight from the mime type — these
// are unambiguous, so we skip the LLM round-trip. text/plain is prose ("text");
// markdown and source-code mimes are "code". Returns null for any other mime so
// the caller falls back to the LLM document classifier.
export function classifyTextCodeByMime(mimeType: string): "text" | "code" | null {
  const m = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (m === "text/plain") return "text";
  if (
    m === "text/markdown" ||
    m.startsWith("text/x-") ||
    m === "application/json" ||
    m === "application/x-yaml" ||
    m === "application/xml"
  ) {
    return "code";
  }
  return null;
}

// Top-level classification values that mean "document" (these are what land
// in `assets.classification` — id-card already collapses to "document" via
// taxonomy.legacyClassificationFor; "text"/"code" come from text-mime docs).
const DOCUMENT_CLASSIFICATIONS = new Set([
  "document",
  "receipt",
  "scan",
  "report",
  "form",
  "contract",
  "letter",
  "text",
  "code",
]);

// Task 20 — graphics kind: logos / mockups / icons / stickers / clipart and
// curated art/cover-art/meme classifications. These all land in their own
// library lens instead of polluting Moments OR Screenshots.
// ADR 0001 §3 — wallpaper + diagram added as new graphics top-keys.
export const GRAPHICS_CLASSIFICATIONS = new Set([
  "logo",
  "mockup",
  "icon",
  "sticker",
  "clipart",
  "art",
  "cover-art",
  "meme",
  "wallpaper",
  "diagram",
]);

function isDocumentMime(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    mimeType === "application/msword" ||
    mimeType.startsWith("text/") ||
    mimeType.startsWith("application/vnd.openxmlformats-officedocument.")
  );
}

export interface KindInput {
  mimeType: string;
  classification: string | null;
  // Task 20 — filename is required for the camera-roll positive-evidence test
  // in deriveKind (looksLikeCameraPhoto). Pass the asset filename verbatim.
  filename: string;
  // Phase 7.1 — real-camera-capture signals. Any one of these being set
  // positively identifies a photo (not a screenshot / logo / icon). cameraMake
  // ALONE doesn't count: iOS + Android stamp the device make on screenshots
  // too. exposureTime / fNumber / iso / focalLength / lensModel are only ever
  // set by a real camera capture pipeline.
  exposureTime?: string | null;
  fNumber?: number | null;
  iso?: number | null;
  focalLength?: number | null;
  lensModel?: string | null;
  // ADR 0001 §4 — heuristic inputs. processAsset.ts already fetches these;
  // pass them through so deriveKind can run isWhiteboardCapture,
  // ocrLooksLikePaperDocument, isPhotoOfArt, and isScreenshot in-line.
  widthPx?: number | null;
  heightPx?: number | null;
  subClassification?: string | null;
  ocrText?: string | null;
}

/**
 * Pure KIND resolution. Remediation spec 2026-06-10 precedence (priority 1 wins):
 *
 *   1. video/* mime → video
 *   2. document mime → document
 *   3. classification ∈ DOCUMENT_CLASSIFICATIONS → document (trusted vision; beats EXIF)
 *   4. classification/sub === "whiteboard" → document (trusted vision)
 *   5. classification === "screenshot" → screenshot (trusted vision)
 *   6. screenshot-by-FILENAME AND !looksLikeCameraPhoto → screenshot
 *   7. ocrLooksLikePaperDocument() → document
 *   8. isWhiteboardCapture() OCR heuristic → document
 *   9. classification ∈ GRAPHICS_CLASSIFICATIONS AND !looksLikeCameraPhoto → graphics
 *  10. image/* AND looksLikeCameraPhoto → moment
 *  10.5. image/* AND !looksLikeCameraPhoto AND fallback shape signal → demote
 *        (2026-06-16: image/png → screenshot, image/gif → graphics,
 *        hasOverlayText(ocr) → graphics — catches CLIP-low-confidence
 *        memes / captioned screenshots / Drive-stripped PNG screen captures
 *        the LLM fallback defaulted to "photo")
 *  11. image/* fallback → moment
 *  12. unknown mime → moment
 *
 * Key change (2026-06-10): a CONTENT screenshot (trusted classification, or a
 * Screenshot* filename with no camera evidence) beats the OCR-document
 * heuristic, so text-heavy screenshots (code/web/chat) stop landing in
 * Documents. The aspect-ratio-only signal no longer forces screenshot — an
 * EXIF-stripped tall photo falls through to moment.
 *
 * Asymmetry invariant: rule 3 IGNORES EXIF (operator's north star — phone
 * photo of paper is a document), rule 9 REQUIRES no EXIF (museum painting
 * photo stays a moment).
 *
 * Idempotency: pure function of inputs. Re-running on the same row with the
 * same inputs always produces the same kind.
 */
export function deriveKind(asset: KindInput): Kind {
  const {
    mimeType,
    classification,
    filename,
    widthPx = null,
    heightPx = null,
    subClassification = null,
    ocrText = null,
  } = asset;
  const exif = {
    exposureTime: asset.exposureTime ?? null,
    fNumber: asset.fNumber ?? null,
    iso: asset.iso ?? null,
    focalLength: asset.focalLength ?? null,
    lensModel: asset.lensModel ?? null,
  };

  // Rule 1 — video mime.
  if (mimeType.startsWith("video/")) return "video";
  // Rule 2 — document mime (PDF, docx, text/*).
  if (isDocumentMime(mimeType)) return "document";
  // Rule 3 — document classification beats EXIF. Operator's north star:
  // a phone photo of paper is a document.
  if (classification && DOCUMENT_CLASSIFICATIONS.has(classification)) return "document";
  // Rule 4 — trusted-vision whiteboard. CLIP/LLM grounded on the whiteboard
  // prompt; trust it ahead of the screenshot branches.
  if (classification === "whiteboard" || subClassification === "whiteboard") {
    return "document";
  }
  // Rule 5 — trusted-vision screenshot. The model already said this IS a
  // screenshot; honor it ahead of the OCR-document heuristic so text-heavy
  // screenshots (code/web/chat) stop landing in Documents.
  if (classification === "screenshot") return "screenshot";
  // Rule 6 — screenshot-by-FILENAME, gated by no camera evidence. A
  // "Screenshot..." name is intentional. Moved ABOVE the OCR-document
  // heuristic (spec 2026-06-10). The aspect-ratio-only signal is NOT used
  // here — shape ≠ content, so an EXIF-stripped tall photo falls through.
  if (isScreenshotByName(filename) && !looksLikeCameraPhoto(filename, mimeType, exif)) {
    return "screenshot";
  }
  // Rule 7 — OCR-based paper-document detection. Now only sees non-screenshot
  // text images. Catches receipts/invoices the classifier missed but OCR did.
  if (ocrLooksLikePaperDocument(ocrText)) return "document";
  // Rule 8 — whiteboard capture OCR heuristic (handles people-in-front case
  // where classifier sees portrait/event but the intent is the whiteboard).
  if (
    isWhiteboardCapture({
      widthPx,
      heightPx,
      filename,
      classification,
      subClassification,
      ocrText,
    })
  ) {
    return "document";
  }
  // Rule 9 — graphics classification requires no real-camera-capture
  // evidence. Museum painting photo (classification=art + EXIF) falls
  // through; downloaded artwork JPEG (classification=art + no EXIF) routes
  // here.
  if (classification && GRAPHICS_CLASSIFICATIONS.has(classification)) {
    // ADR 0001 §6 — isPhotoOfArt forces moment for classification=art + EXIF
    // even before we check looksLikeCameraPhoto. Equivalent to the EXIF gate
    // for the art-specific case, but explicit so the intent is readable.
    if (isPhotoOfArt({ classification, exif, ocrText })) {
      return "moment";
    }
    if (!looksLikeCameraPhoto(filename, mimeType, exif)) {
      return "graphics";
    }
    // Graphics classification + camera EXIF = photo-of-graphic-in-the-world
    // (e.g. storefront logo). Fall through to the camera-photo path → moment.
  }
  // Rule 10 — image with positive camera evidence → moment.
  if (mimeType.startsWith("image/") && looksLikeCameraPhoto(filename, mimeType, exif)) {
    return "moment";
  }
  // Rule 10.5 (2026-06-16) — fallback graphics-shape signals when the
  // classifier defaulted to "photo" (commonly because CLIP confidence was
  // low and the LLM fallback returned the safe "photo" default) AND there
  // is no camera-capture evidence. Three patterns are confidently NOT
  // candid camera moments and get demoted before rule 11's "trust the
  // unknown image" fall-through:
  //
  //   - image/png: real photos arrive as JPEG / HEIC / RAW; a standalone
  //     PNG with no EXIF and no camera-roll filename is virtually always a
  //     screen capture whose "Screenshot..." filename was lost in transit
  //     (Drive re-encode, chat-app strip). Route to screenshot, since the
  //     content is a screen, not a graphic asset.
  //   - image/gif: animation format used for memes, stickers, reactions,
  //     never a candid camera moment.
  //   - hasOverlayText(ocr): substantial overlay text on an image with no
  //     camera evidence = meme / captioned screenshot / chat clip.
  //
  // Asymmetry stays consistent with rule 9 (graphics requires no EXIF) — a
  // real photo with a street sign in frame, a wedding-card pickup, or a
  // museum-painting capture has camera EXIF or a camera-roll name and so
  // gates out one rule earlier on looksLikeCameraPhoto.
  if (
    mimeType.startsWith("image/") &&
    !looksLikeCameraPhoto(filename, mimeType, exif)
  ) {
    if (mimeType === "image/png") return "screenshot";
    if (mimeType === "image/gif") return "graphics";
    if (hasOverlayText(ocrText)) return "graphics";
  }
  // Rule 11 — operator policy (2026-06-10): an unknown image is a photo →
  // moment. Logos/icons/etc. route to graphics via classification (rule 9);
  // content/filename screenshots already routed above. The aspect-ratio-only
  // signal no longer pushes EXIF-stripped photos into Screenshots.
  if (mimeType.startsWith("image/")) return "moment";
  // Rule 12 — unknown mime fallback (pre-existing behaviour).
  return "moment";
}
