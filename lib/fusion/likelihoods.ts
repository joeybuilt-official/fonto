// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0003). Per-evidence-type likelihood
// functions: each maps one evidence row to an unnormalised likelihood vector
// over the monthly grid (values ≥ 0, peak ≈ 1). The combiner then folds them as
// Σ weight·log(L + ε). Pure + DB-free.
//
// Adding/removing an evidence type is a change HERE, never a schema change
// (ADR-0003). Types with no Phase 3 producer (trip_match, cluster_propagation,
// co_occurrence, apparent_age) still have a likelihood fn so they fuse correctly
// the moment a producer ships.

import type { EvidenceRowInput, FusionConfig } from "./types";
import {
  type Grid,
  absMonth,
  isoToCell,
  cellMonth,
} from "./grid";

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function toStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Cell for an ISO string, clamped into the grid (before→0, after→size-1). */
function clampIsoCell(grid: Grid, iso: string): number | null {
  const exact = isoToCell(grid, iso);
  if (exact != null) return exact;
  const m = iso.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return null;
  const abs = absMonth(Number(m[1]), m[2] ? Number(m[2]) : 1);
  return abs < grid.startAbs ? 0 : grid.size - 1;
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function windowLikelihood(
  grid: Grid,
  loCell: number,
  hiCell: number,
  inside: number,
  outside: number
): number[] {
  const lo = Math.max(0, Math.min(loCell, hiCell));
  const hi = Math.min(grid.size - 1, Math.max(loCell, hiCell));
  const v = new Array<number>(grid.size);
  for (let i = 0; i < grid.size; i++) v[i] = i >= lo && i <= hi ? inside : outside;
  return v;
}

function gaussianLikelihood(grid: Grid, centerCell: number, sigmaCells: number): number[] {
  const sigma = Math.max(0.25, sigmaCells);
  const v = new Array<number>(grid.size);
  for (let i = 0; i < grid.size; i++) {
    const d = (i - centerCell) / sigma;
    v[i] = Math.exp(-0.5 * d * d);
  }
  return v;
}

function monthMaskLikelihood(
  grid: Grid,
  months: Set<number>,
  inside: number,
  outside: number
): number[] {
  const v = new Array<number>(grid.size);
  for (let i = 0; i < grid.size; i++) v[i] = months.has(cellMonth(grid, i)) ? inside : outside;
  return v;
}

function upperRampLikelihood(grid: Grid, hiCell: number, inside: number, outside: number): number[] {
  const v = new Array<number>(grid.size);
  for (let i = 0; i < grid.size; i++) v[i] = i <= hiCell ? inside : outside;
  return v;
}

/**
 * Build the likelihood vector for one evidence row. Returns null when the row
 * carries no usable signal (the caller skips it — absent evidence, never a flat
 * contribution that would wash out real signal).
 */
export function likelihoodFor(
  row: EvidenceRowInput,
  grid: Grid,
  config: FusionConfig
): number[] | null {
  const sd = row.sourceDetail;
  const EPS_OUT = config.epsilon;

  switch (row.evidenceType) {
    case "identity_bound":
    case "co_occurrence": {
      const lowerBound = toStr(sd.lowerBound);
      const upperBound = toStr(sd.upperBound);
      if (!lowerBound && !upperBound) return null;
      const lo = lowerBound ? clampIsoCell(grid, lowerBound) : 0;
      const hi = upperBound ? clampIsoCell(grid, upperBound) : grid.size - 1;
      if (lo == null || hi == null) return null;
      return windowLikelihood(grid, lo, hi, 1, EPS_OUT);
    }

    case "exif":
    case "filename": {
      const iso = toStr(sd.iso);
      if (!iso) return null;
      const c = clampIsoCell(grid, iso);
      if (c == null) return null;
      const sigma =
        row.evidenceType === "exif" ? config.exifSigmaMonths : config.filenameSigmaMonths;
      return gaussianLikelihood(grid, c, sigma);
    }

    case "fs_mtime": {
      const iso = toStr(sd.iso);
      if (!iso) return null;
      const c = clampIsoCell(grid, iso);
      if (c == null) return null;
      // Taken at-or-before ingest: flat up to the ingest month, strongly (not
      // fully) suppressed after to tolerate clock skew. Lowest weight anyway.
      return upperRampLikelihood(grid, c, 1, 0.02);
    }

    case "ocr_date": {
      const matches = Array.isArray(sd.matches) ? sd.matches : [];
      if (matches.length === 0) return null;
      const acc = zeros(grid.size);
      let any = false;
      for (const raw of matches) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as Record<string, unknown>;
        const iso = toStr(m.iso);
        const precision = toStr(m.precision);
        const conf = Math.max(0, Math.min(1, toNum(m.confidence) ?? 0.5));
        if (!iso) continue;
        let kernel: number[];
        if (precision === "year") {
          const m2 = iso.match(/^(\d{4})/);
          if (!m2) continue;
          const y = Number(m2[1]);
          const lo = clampIsoCell(grid, `${y}-01`);
          const hi = clampIsoCell(grid, `${y}-12`);
          if (lo == null || hi == null) continue;
          kernel = windowLikelihood(grid, lo, hi, 1, 0);
        } else {
          const c = clampIsoCell(grid, iso);
          if (c == null) continue;
          kernel = gaussianLikelihood(grid, c, config.ocrDaySigmaMonths);
        }
        for (let i = 0; i < grid.size; i++) acc[i] += conf * kernel[i];
        any = true;
      }
      return any ? acc : null;
    }

    case "scene_season": {
      const monthsArr = Array.isArray(sd.months) ? sd.months : [];
      const months = new Set<number>(
        monthsArr.map((x) => toNum(x)).filter((n): n is number => n != null && n >= 1 && n <= 12)
      );
      if (months.size === 0) return null;
      // Soft outside — a season is a hint, not a hard bound.
      return monthMaskLikelihood(grid, months, 1, 0.15);
    }

    case "trip_match": {
      const dateStart = toStr(sd.dateStart) ?? toStr(sd.iso);
      const dateEnd = toStr(sd.dateEnd) ?? dateStart;
      if (!dateStart || !dateEnd) return null;
      const lo = clampIsoCell(grid, dateStart);
      const hi = clampIsoCell(grid, dateEnd);
      if (lo == null || hi == null) return null;
      const conf = Math.max(0, Math.min(1, toNum(sd.confidence) ?? 1));
      const leak = Math.max(0.02, (1 - conf) * 0.3);
      return windowLikelihood(grid, lo, hi, 1, leak);
    }

    case "cluster_propagation": {
      // Only ever produced from an operator-CONFIRMED neighbour date/range
      // (ADR-0003 propagation gate) — the engine trusts the row.
      const dateStart = toStr(sd.dateStart);
      const dateEnd = toStr(sd.dateEnd);
      const iso = toStr(sd.iso);
      if (dateStart && dateEnd) {
        const lo = clampIsoCell(grid, dateStart);
        const hi = clampIsoCell(grid, dateEnd);
        if (lo == null || hi == null) return null;
        return windowLikelihood(grid, lo, hi, 1, config.epsilon);
      }
      if (iso) {
        const c = clampIsoCell(grid, iso);
        if (c == null) return null;
        return gaussianLikelihood(grid, c, 1);
      }
      return null;
    }

    case "apparent_age": {
      // No producer in v1 (D4); ready for when an age Tool ships.
      const birthDate = toStr(sd.birthDate);
      const ageYears = toNum(sd.ageYears);
      if (!birthDate || ageYears == null) return null;
      const m = birthDate.match(/^(\d{4})(?:-(\d{2}))?/);
      if (!m) return null;
      const centerAbs = absMonth(Number(m[1]), m[2] ? Number(m[2]) : 1) + Math.round(ageYears * 12);
      const centerCell = centerAbs - grid.startAbs;
      const sigmaYears = toNum(sd.sigmaYears) ?? Math.max(1, ageYears * 0.15);
      return gaussianLikelihood(grid, centerCell, sigmaYears * 12);
    }

    default:
      return null;
  }
}
