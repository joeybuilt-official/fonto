// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. The evidence adapters: each turns one signal
// source into an `EvidenceInput` (or null when the source is silent). Kept thin
// + mostly pure — the heavy parsing lives in season.ts / ocrDates.ts; the Plexo
// I/O lives in the orchestrator (extractAssetEvidence.ts). The orchestrator owns
// the provenance stamping of perception-backed model versions.

import { dateFromFilename } from "@/lib/exif";
import type { Precision } from "@/lib/temporal/precision";
import type { EvidenceInput } from "./types";
import { parseOcrDates } from "./ocrDates";
import { seasonMaskFromLabels } from "./season";

// Fonto-local rule versions. Bumping one re-extracts ONLY that evidence type
// (ADR-0006). Perception-backed types (scene_season) version off the Plexo
// model id instead — see SCENE_SEASON_RULE below.
export const IDENTITY_MODEL_VERSION = "identity-bound@1";
export const OCR_DATE_MODEL_VERSION = "ocr-date@1";
export const EXIF_MODEL_VERSION = "exif@1";
export const FILENAME_MODEL_VERSION = "filename@1";
export const FS_MTIME_MODEL_VERSION = "fs-mtime@1";
/** Rule prefix; the full model_version is `${SCENE_SEASON_RULE}/${plexoModelId}`. */
export const SCENE_SEASON_RULE = "scene-season@1";

export interface PersonDateBounds {
  personId: string;
  birthDate: string | null; // 'YYYY-MM-DD' (first-of-period)
  birthPrecision: string | null;
  deathDate: string | null;
  deathPrecision: string | null;
}

/**
 * Identity bound: every identified person in the photo must have been alive when
 * it was taken. The binding window is [max(births) .. min(deaths)] — the photo is
 * after the LATEST-born subject's birth and before the EARLIEST-dead subject's
 * death. Emits nothing when no present person carries a date (no constraint).
 */
export function identityEvidence(persons: PersonDateBounds[]): EvidenceInput | null {
  const births = persons.map((p) => p.birthDate).filter((d): d is string => !!d);
  const deaths = persons.map((p) => p.deathDate).filter((d): d is string => !!d);
  if (births.length === 0 && deaths.length === 0) return null;

  // ISO 'YYYY-MM-DD' strings sort lexicographically == chronologically.
  const lowerBound = births.length ? births.reduce((a, b) => (a > b ? a : b)) : null;
  const upperBound = deaths.length ? deaths.reduce((a, b) => (a < b ? a : b)) : null;

  return {
    evidenceType: "identity_bound",
    modelVersion: IDENTITY_MODEL_VERSION,
    sourceDetail: {
      persons: persons.map((p) => ({
        personId: p.personId,
        birthDate: p.birthDate,
        birthPrecision: p.birthPrecision,
        deathDate: p.deathDate,
        deathPrecision: p.deathPrecision,
      })),
      lowerBound,
      upperBound,
    },
  };
}

/**
 * Scene-season: VLM labels → a year-agnostic monthly mask. `plexoModelId` is the
 * label model's id (provenance — a model swap re-extracts this type). Emits
 * nothing when no label was seasonal.
 */
export function sceneSeasonEvidence(
  labels: string[],
  plexoModelId: string
): EvidenceInput | null {
  const mask = seasonMaskFromLabels(labels);
  if (mask.months.length === 0) return null;
  return {
    evidenceType: "scene_season",
    modelVersion: `${SCENE_SEASON_RULE}/${plexoModelId || "unknown"}`,
    sourceDetail: {
      seasons: mask.seasons,
      months: mask.months,
      matchedLabels: mask.matchedLabels,
      labels,
    },
  };
}

/** OCR date(s) parsed from stored OCR text. Emits nothing when none parse. */
export function ocrDateEvidence(ocrText: string | null | undefined): EvidenceInput | null {
  const matches = parseOcrDates(ocrText);
  if (matches.length === 0) return null;
  return {
    evidenceType: "ocr_date",
    modelVersion: OCR_DATE_MODEL_VERSION,
    sourceDetail: { matches },
  };
}

function coerceIsoDay(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1995 || d.getTime() > Date.now() + 86_400_000) return null;
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/**
 * EXIF capture stamp — a moderate-weight HYPOTHESIS to validate, not an
 * authority (recovered EXIF can be corrupt; ADR-0003). Reads the raw exifr blob
 * stored on the asset; prefers DateTimeOriginal, then CreateDate, then
 * ModifyDate. Emits nothing when no usable date is present.
 */
export function exifEvidence(exifRaw: Record<string, unknown> | null): EvidenceInput | null {
  if (!exifRaw) return null;
  const sources: Array<["DateTimeOriginal" | "CreateDate" | "ModifyDate", unknown]> = [
    ["DateTimeOriginal", exifRaw.DateTimeOriginal],
    ["CreateDate", exifRaw.CreateDate],
    ["ModifyDate", exifRaw.ModifyDate],
  ];
  for (const [source, raw] of sources) {
    const iso = coerceIsoDay(raw);
    if (iso) {
      return {
        evidenceType: "exif",
        modelVersion: EXIF_MODEL_VERSION,
        sourceDetail: { iso, precision: "day" as Precision, source },
      };
    }
  }
  return null;
}

/**
 * Filename date — moderate weight. Reuses the same device-pattern parser the
 * ingest pipeline uses for `captured_at` fallback (lib/exif.dateFromFilename),
 * so the two never disagree on what a filename means. Emits nothing on no match.
 */
export function filenameEvidence(filename: string): EvidenceInput | null {
  const d = dateFromFilename(filename);
  if (!d) return null;
  const iso = coerceIsoDay(d);
  if (!iso) return null;
  return {
    evidenceType: "filename",
    modelVersion: FILENAME_MODEL_VERSION,
    sourceDetail: { iso, precision: "day" as Precision, filename },
  };
}

/**
 * fs-mtime floor — the WIDEST, LOWEST-weight evidence (ADR-0003). We source it
 * from the asset's ingest timestamp: a photo was necessarily taken at-or-before
 * it was uploaded. For a truly dateless asset this is the only bound; fusion
 * weights it lowest so it never overrides a real signal. `source` is stamped so
 * Phase 4 can down-weight ingest-derived mtime further if desired.
 */
export function fsMtimeEvidence(createdAt: Date): EvidenceInput {
  return {
    evidenceType: "fs_mtime",
    modelVersion: FS_MTIME_MODEL_VERSION,
    sourceDetail: { iso: createdAt.toISOString(), source: "ingest_created_at" },
  };
}
