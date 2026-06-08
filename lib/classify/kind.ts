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
// v1 ships four KINDs. "Saved" (memes / art / logos / downloaded non-photos)
// is deferred: the classifier collapses meme/art/cover-art/whiteboard →
// "photo" and the Drive import stripped EXIF, so Moment-vs-Saved isn't
// cleanly derivable yet — those fall through to `moment` for now (ADR D5).

export const KIND = ["moment", "screenshot", "document", "video"] as const;
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
}

function hasRealCameraSignals(asset: KindInput): boolean {
  return Boolean(
    (asset.exposureTime !== null && asset.exposureTime !== undefined && asset.exposureTime !== "") ||
      (asset.fNumber !== null && asset.fNumber !== undefined && asset.fNumber > 0) ||
      (asset.iso !== null && asset.iso !== undefined && asset.iso > 0) ||
      (asset.focalLength !== null && asset.focalLength !== undefined && asset.focalLength > 0) ||
      (asset.lensModel !== null && asset.lensModel !== undefined && asset.lensModel !== ""),
  );
}

/**
 * Pure KIND resolution. Phase 7.1 — Moments require POSITIVE evidence of a
 * real camera capture (an exposure parameter or a lens). Images that lack
 * that evidence (screenshots, logos, icons, mockups, app captures, debug
 * snapshots) fall into `screenshot` rather than polluting the default lens.
 *
 * The override at processAsset.ts:172 used to flip phone screenshots back to
 * "photo" because cameraMake is non-null — but iOS / Android stamp the device
 * on screenshots too. This rule fixes the resulting Moment flood.
 */
export function deriveKind(asset: KindInput): Kind {
  const { mimeType, classification } = asset;
  if (mimeType.startsWith("video/")) return "video";
  if (classification === "screenshot") return "screenshot";
  if (isDocumentMime(mimeType)) return "document";
  if (classification && DOCUMENT_CLASSIFICATIONS.has(classification)) return "document";
  // Image without a screenshot/document/video signal — Moment only if a
  // real-camera-capture parameter is present. Otherwise treat as screenshot.
  if (mimeType.startsWith("image/")) {
    return hasRealCameraSignals(asset) ? "moment" : "screenshot";
  }
  // Unknown mime — pre-existing fallback.
  return "moment";
}
