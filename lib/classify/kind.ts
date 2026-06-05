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
}

/**
 * Pure KIND resolution. Null/unknown classification (e.g. the in-flight
 * `captured` backlog, or camera images the classifier hasn't reached)
 * defaults to `moment` — the pre-mortem fallback that keeps real photos in
 * the default lens; a later re-classify only moves edge cases.
 */
export function deriveKind(asset: KindInput): Kind {
  const { mimeType, classification } = asset;
  if (mimeType.startsWith("video/")) return "video";
  if (classification === "screenshot") return "screenshot";
  if (isDocumentMime(mimeType)) return "document";
  if (classification && DOCUMENT_CLASSIFICATIONS.has(classification)) return "document";
  return "moment";
}
