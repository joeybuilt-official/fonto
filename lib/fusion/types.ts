// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0003). Types for the pure fusion engine that
// turns an asset's evidence rows into a single dated proposal. DB-free +
// network-free: everything here is plain data so the engine is unit-testable
// against synthetic evidence (scripts/test-fusion.ts).

import type { EvidenceType } from "@/lib/evidence/types";
import type { Precision } from "@/lib/temporal/precision";

export type { EvidenceType };
export type { Precision };

/**
 * One evidence row, as the engine consumes it. Mirrors a
 * `fonto.image_date_evidence` row minus the DB-only columns. `createdAt` is used
 * only to keep the latest rows per (evidence_type) — supersession filtering
 * (ADR-0006); fusion never mixes two model_versions of the same type.
 */
export interface EvidenceRowInput {
  evidenceType: EvidenceType;
  sourceDetail: Record<string, unknown>;
  modelVersion: string;
  createdAt: Date;
}

export interface FuseOptions {
  /** The asset's authoritative captured_at, if any — used only for conflict. */
  storedCapturedAt?: Date | null;
  /** "Now" for the grid's upper edge + open-ended identity windows. */
  now?: Date;
  config?: Partial<FusionConfig>;
}

export interface FusionConfig {
  /** Grid lower edge (inclusive). */
  gridStartYear: number;
  gridStartMonth: number; // 1..12
  /** Fraction of posterior mass the HDI must cover. */
  hdiMass: number;
  /** Confidence "peak" half-width in cells either side of the MAP. */
  peakK: number;
  /** Absolute density floor: stored captured_at below this is always a conflict. */
  conflictTau: number;
  /**
   * Relative conflict bar: a stored captured_at whose density is below
   * `conflictRatio × density(MAP)` is a clearly-inferior hypothesis → conflict.
   * Catches the bimodal "EXIF says X, OCR says Y" case where the wide 90% HDI
   * would otherwise swallow both modes.
   */
  conflictRatio: number;
  /** Floor added inside every log() so a zero likelihood is a finite penalty. */
  epsilon: number;
  /** Per-evidence-type exponent on the log-likelihood (the weight cap). */
  weights: Record<EvidenceType, number>;
  /** Gaussian spreads (in months) for the spike-shaped evidence types. */
  exifSigmaMonths: number;
  filenameSigmaMonths: number;
  ocrDaySigmaMonths: number;
}

export interface ExplanationEntry {
  evidenceType: EvidenceType;
  modelVersion: string;
  weight: number;
  /** weight × log(L[MAP] + ε): how hard this row pushed toward the MAP cell. */
  contribution: number;
  /** A short human-facing summary of the row (the artifact). */
  detail: string;
}

export interface DependsOn {
  personIds: string[];
  factIds: string[];
  modelVersions: string[];
  neighborAssetIds: string[];
}

export interface InferenceResult {
  /** MAP point estimate as an ISO date (YYYY-MM-DD), or null on cold-start. */
  mapEstimate: string | null;
  mapPrecision: Precision | null;
  /** Bounding range of the HDI (ISO YYYY-MM-DD, first-of-month), or null. */
  ciLow: string | null;
  ciHigh: string | null;
  confidence: number;
  conflictFlag: boolean;
  conflictDetail: Record<string, unknown> | null;
  explanation: ExplanationEntry[];
  dependsOn: DependsOn;
  /** True when no evidence row produced a usable likelihood (cold-start). */
  coldStart: boolean;
}
