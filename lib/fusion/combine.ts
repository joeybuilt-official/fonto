// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0003). The log-space combiner + the
// derivations off the posterior (MAP, HDI, confidence, conflict). Pure.

import type { FusionConfig } from "./types";
import { type Grid, dateToCell } from "./grid";

export interface Contribution {
  weight: number;
  /** Likelihood vector over the grid (values ≥ 0). */
  L: number[];
}

/**
 * Flat prior; logPost[i] = Σ weight·log(L[i] + ε). Returns the normalised
 * posterior (sums to 1). An empty contribution list yields a uniform posterior.
 */
export function combinePosterior(
  contribs: Contribution[],
  grid: Grid,
  config: FusionConfig
): number[] {
  const logPost = new Array<number>(grid.size).fill(0);
  for (const { weight, L } of contribs) {
    for (let i = 0; i < grid.size; i++) {
      logPost[i] += weight * Math.log(L[i] + config.epsilon);
    }
  }
  // Softmax with max-subtraction for numerical stability.
  let max = -Infinity;
  for (let i = 0; i < grid.size; i++) if (logPost[i] > max) max = logPost[i];
  let sum = 0;
  const post = new Array<number>(grid.size);
  for (let i = 0; i < grid.size; i++) {
    const e = Math.exp(logPost[i] - max);
    post[i] = e;
    sum += e;
  }
  if (sum <= 0 || !Number.isFinite(sum)) {
    // Degenerate — fall back to uniform.
    return new Array<number>(grid.size).fill(1 / grid.size);
  }
  for (let i = 0; i < grid.size; i++) post[i] /= sum;
  return post;
}

export function argmax(posterior: number[]): number {
  let best = 0;
  for (let i = 1; i < posterior.length; i++) if (posterior[i] > posterior[best]) best = i;
  return best;
}

export interface HdiResult {
  cells: Set<number>;
  loCell: number;
  hiCell: number;
  count: number;
  spanMonths: number;
}

/**
 * Highest-density interval: greedily take cells by descending mass until ≥ mass
 * is covered. ci_low..ci_high is the bounding range of the chosen set (the set
 * may be non-contiguous; we report its envelope per ADR-0003).
 */
export function hdiSet(posterior: number[], mass: number): HdiResult {
  const order = posterior.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
  const cells = new Set<number>();
  let acc = 0;
  let lo = order.length ? order[0].i : 0;
  let hi = lo;
  for (const { p, i } of order) {
    cells.add(i);
    if (i < lo) lo = i;
    if (i > hi) hi = i;
    acc += p;
    if (acc >= mass) break;
  }
  return { cells, loCell: lo, hiCell: hi, count: cells.size, spanMonths: hi - lo + 1 };
}

/** Posterior mass within ±k cells of the MAP. */
export function peakMass(posterior: number[], mapCell: number, k: number): number {
  let m = 0;
  for (let i = Math.max(0, mapCell - k); i <= Math.min(posterior.length - 1, mapCell + k); i++) {
    m += posterior[i];
  }
  return m;
}

/**
 * Confidence = peak mass around the MAP, penalised by how wide the HDI is. Flat
 * / cold-start posteriors collapse to ~0 by construction (the peak mass of a
 * uniform vector is tiny) — the AI-seat requirement that no confident MAP comes
 * off a flat prior.
 */
export function confidenceScore(
  posterior: number[],
  mapCell: number,
  hdi: HdiResult,
  config: FusionConfig
): number {
  const peak = peakMass(posterior, mapCell, config.peakK);
  const size = posterior.length;
  const widthPenalty = size <= 1 ? 1 : 1 - (hdi.count - 1) / size;
  return Math.max(0, Math.min(1, peak * widthPenalty));
}

export interface ConflictResult {
  conflict: boolean;
  detail: Record<string, unknown> | null;
}

/**
 * Conflict ≜ the stored captured_at is a clearly-inferior hypothesis to the
 * engine's estimate (ADR-0003). Fires when the stored month's posterior density
 * is below MAX(τ, conflictRatio × density(MAP)) — i.e. it is either an absolute
 * outlier OR a far-weaker mode than the MAP. The relative bar catches the
 * bimodal "EXIF says X, OCR says Y" case the raw 90% HDI would miss. A confident
 * unimodal estimate that agrees with the stored date never conflicts (their
 * densities are comparable); a flat/cold posterior never conflicts either (no
 * mode dominates). No stored date ⇒ no conflict.
 */
export function detectConflict(
  posterior: number[],
  grid: Grid,
  storedCapturedAt: Date | null | undefined,
  mapCell: number,
  config: FusionConfig
): ConflictResult {
  if (!storedCapturedAt) return { conflict: false, detail: null };
  const cell = dateToCell(grid, storedCapturedAt);
  if (cell == null) {
    return {
      conflict: true,
      detail: { reason: "stored-outside-grid", storedCapturedAt: storedCapturedAt.toISOString() },
    };
  }
  const density = posterior[cell];
  const mapDensity = posterior[mapCell];
  const threshold = Math.max(config.conflictTau, config.conflictRatio * mapDensity);
  const conflict = density < threshold;
  return {
    conflict,
    detail: conflict
      ? {
          reason: density < config.conflictTau ? "low-density-at-stored" : "inferior-mode-vs-map",
          storedCapturedAt: storedCapturedAt.toISOString(),
          densityAtStored: density,
          densityAtMap: mapDensity,
        }
      : null,
  };
}
