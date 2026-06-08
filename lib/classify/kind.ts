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

import { looksLikeCameraPhoto } from "../processing/classifyHelpers";

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
export const GRAPHICS_CLASSIFICATIONS = new Set([
  "logo",
  "mockup",
  "icon",
  "sticker",
  "clipart",
  "art",
  "cover-art",
  "meme",
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
}

/**
 * Pure KIND resolution. Task 20 priority:
 *   1. video/* mime → video
 *   2. document mime → document
 *   3. classification ∈ DOCUMENT_CLASSIFICATIONS → document
 *   4. classification ∈ GRAPHICS_CLASSIFICATIONS → graphics
 *   5. classification === "screenshot" → screenshot
 *   6. image/* + looksLikeCameraPhoto → moment
 *   7. image/* fallback → screenshot
 *   8. unknown mime → moment (existing fallback)
 *
 * Moments require POSITIVE evidence of a real camera capture (EXIF exposure
 * param OR a camera-roll filename pattern OR a RAW/HEIC mime). Images that
 * lack that evidence and aren't otherwise classified fall into `screenshot`
 * rather than polluting the default lens.
 */
export function deriveKind(asset: KindInput): Kind {
  const { mimeType, classification, filename } = asset;
  if (mimeType.startsWith("video/")) return "video";
  if (isDocumentMime(mimeType)) return "document";
  if (classification && DOCUMENT_CLASSIFICATIONS.has(classification)) return "document";
  if (classification && GRAPHICS_CLASSIFICATIONS.has(classification)) return "graphics";
  if (classification === "screenshot") return "screenshot";
  if (mimeType.startsWith("image/")) {
    return looksLikeCameraPhoto(filename, mimeType, asset) ? "moment" : "screenshot";
  }
  // Unknown mime — pre-existing fallback.
  return "moment";
}
