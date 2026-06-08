// SPDX-License-Identifier: AGPL-3.0-only
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
  isScreenshot,
  isWhiteboardCapture,
  isPhotoOfArt,
  ocrLooksLikePaperDocument,
} from "../processing/classifyHelpers";

export const KIND = ["moment", "screenshot", "graphics", "document", "video"] as const;
export type Kind = (typeof KIND)[number];

export function isKind(value: string): value is Kind {
  return (KIND as readonly string[]).includes(value);
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
 * Pure KIND resolution. ADR 0001 §4 priority order (priority 1 wins):
 *
 *   1. video/* mime → video
 *   2. document mime → document
 *   3. classification ∈ DOCUMENT_CLASSIFICATIONS → document (beats EXIF)
 *   4. isWhiteboardCapture() → document
 *   5. ocrLooksLikePaperDocument() → document
 *   6. classification ∈ GRAPHICS_CLASSIFICATIONS AND !looksLikeCameraPhoto → graphics
 *   7. classification === "screenshot" OR isScreenshot() → screenshot
 *   8. image/* AND looksLikeCameraPhoto → moment
 *   9. image/* fallback → screenshot
 *  10. unknown mime → moment
 *
 * Asymmetry invariant: rule 3 IGNORES EXIF (operator's north star — phone
 * photo of paper is a document), rule 6 REQUIRES no EXIF (museum painting
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
  // Rule 4 — whiteboard capture heuristic (handles people-in-front case
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
  // Rule 5 — OCR-based paper-document detection, promoted ahead of graphics.
  // Catches receipts/invoices the classifier missed but OCR caught.
  if (ocrLooksLikePaperDocument(ocrText)) return "document";
  // Rule 6 — graphics classification requires no real-camera-capture
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
  // Rule 7 — explicit screenshot classification OR filename/aspect heuristic.
  if (classification === "screenshot") return "screenshot";
  if (isScreenshot(filename, mimeType, widthPx, heightPx)) {
    // Screenshot heuristic only fires when the classifier hasn't already
    // claimed this row for graphics/document above. EXIF is checked inside
    // — real camera photos that happen to be 9:16 won't match here.
    if (!looksLikeCameraPhoto(filename, mimeType, exif)) {
      return "screenshot";
    }
  }
  // Rule 8 — image with positive camera evidence → moment.
  if (mimeType.startsWith("image/") && looksLikeCameraPhoto(filename, mimeType, exif)) {
    return "moment";
  }
  // Rule 9 — image without camera evidence falls through to screenshot
  // rather than polluting the default Moments lens with logos / icons / etc.
  if (mimeType.startsWith("image/")) return "screenshot";
  // Rule 10 — unknown mime fallback (pre-existing behaviour).
  return "moment";
}
