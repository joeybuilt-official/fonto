// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0003). Default fusion tunables. Everything
// the engine's behaviour depends on lives here so it is operator-overridable
// without a redeploy (a FuseOptions.config patch merges over these).

import type { EvidenceType, FusionConfig } from "./types";

// Per-type exponent on log-likelihood = the "weight cap" (ADR-0003). Higher =
// the type bends the posterior harder. ocr_date (a date printed on the image) is
// the sharpest authority; fs_mtime (ingest time) the weakest. apparent_age is
// capped + has no producer in v1 (D4). identity_bound is a WIDE constraint so it
// is weighted modestly — it shapes, it doesn't pin.
const DEFAULT_WEIGHTS: Record<EvidenceType, number> = {
  ocr_date: 1.2,
  exif: 1.0,
  trip_match: 1.0,
  cluster_propagation: 1.0,
  filename: 0.8,
  apparent_age: 0.6,
  co_occurrence: 0.5,
  identity_bound: 0.4,
  scene_season: 0.3,
  fs_mtime: 0.15,
};

export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  gridStartYear: 1990,
  gridStartMonth: 1,
  hdiMass: 0.9,
  peakK: 2,
  conflictTau: 0.01,
  conflictRatio: 0.25,
  epsilon: 1e-6,
  weights: DEFAULT_WEIGHTS,
  // Sharp spreads: EXIF/filename/OCR carry an EXACT timestamp, so the
  // likelihood is peaked (a precise observation). Their trust/validatability
  // (ADR-0003 "moderate — a hypothesis to validate") is modelled by the WEIGHT
  // (so a stronger source overrides) + the conflict detector — NOT by blurring
  // the date. Sub-1-month sigma also lets a lone clean date day-sharpen.
  exifSigmaMonths: 0.3,
  filenameSigmaMonths: 0.35,
  ocrDaySigmaMonths: 0.3,
};

export function resolveConfig(patch?: Partial<FusionConfig>): FusionConfig {
  if (!patch) return DEFAULT_FUSION_CONFIG;
  return {
    ...DEFAULT_FUSION_CONFIG,
    ...patch,
    weights: { ...DEFAULT_FUSION_CONFIG.weights, ...(patch.weights ?? {}) },
  };
}
