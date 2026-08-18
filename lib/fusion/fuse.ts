// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0003). The pure top-level fusion function:
// (evidence rows, options) → one dated proposal. No I/O. The orchestrator
// (lib/fusion/inferAssetDate.ts) wraps this with DB reads/writes.

import type {
  EvidenceRowInput,
  EvidenceType,
  FuseOptions,
  InferenceResult,
  ExplanationEntry,
  Precision,
  DependsOn,
} from "./types";
import { resolveConfig } from "./config";
import { buildGrid, cellToIsoFirst, cellToYearMonth, dateToCell, isoToCell } from "./grid";
import { likelihoodFor } from "./likelihoods";
import {
  type Contribution,
  combinePosterior,
  argmax,
  hdiSet,
  confidenceScore,
  detectConflict,
} from "./combine";

/** Keep, per evidence_type, only the rows of the most-recently-created
 *  model_version (ADR-0006 supersession — never mix two versions of a type). */
function filterCurrentVersions(rows: EvidenceRowInput[]): EvidenceRowInput[] {
  const latestVersionByType = new Map<EvidenceType, { version: string; at: number }>();
  for (const r of rows) {
    const at = r.createdAt.getTime();
    const cur = latestVersionByType.get(r.evidenceType);
    if (!cur || at > cur.at) latestVersionByType.set(r.evidenceType, { version: r.modelVersion, at });
  }
  return rows.filter((r) => latestVersionByType.get(r.evidenceType)?.version === r.modelVersion);
}

function rowDetail(row: EvidenceRowInput): string {
  const sd = row.sourceDetail;
  switch (row.evidenceType) {
    case "identity_bound":
    case "co_occurrence":
      return `${row.evidenceType} ${String(sd.lowerBound ?? "?")}..${String(sd.upperBound ?? "now")}`;
    case "exif":
      return `exif ${String(sd.iso)} (${String(sd.source ?? "")})`;
    case "filename":
      return `filename ${String(sd.iso)}`;
    case "fs_mtime":
      return `ingest ${String(sd.iso)}`;
    case "ocr_date": {
      const matches = Array.isArray(sd.matches) ? sd.matches : [];
      const top = matches[0] as Record<string, unknown> | undefined;
      return `ocr ${matches.length} date(s)${top ? ` top=${String(top.iso)}` : ""}`;
    }
    case "scene_season":
      return `season months=${JSON.stringify(sd.months ?? [])}`;
    case "trip_match":
      return `trip ${String(sd.dateStart ?? "?")}..${String(sd.dateEnd ?? "?")}`;
    case "cluster_propagation":
      return `cluster ${String(sd.iso ?? sd.dateStart ?? "?")}`;
    case "apparent_age":
      return `age ${String(sd.ageYears ?? "?")}y from ${String(sd.birthDate ?? "?")}`;
    default:
      return row.evidenceType;
  }
}

/** Best exact day available within a given calendar month, weighted, for the
 *  optional day-sharpen of the MAP estimate. */
function dayCandidatesInMonth(
  rows: EvidenceRowInput[],
  weights: Record<EvidenceType, number>,
  year: number,
  month: number
): Array<{ iso: string; weight: number }> {
  const out: Array<{ iso: string; weight: number }> = [];
  const inMonth = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return !!m && Number(m[1]) === year && Number(m[2]) === month;
  };
  for (const r of rows) {
    const sd = r.sourceDetail;
    if ((r.evidenceType === "exif" || r.evidenceType === "filename") && typeof sd.iso === "string" && inMonth(sd.iso)) {
      out.push({ iso: sd.iso, weight: weights[r.evidenceType] });
    } else if (r.evidenceType === "cluster_propagation" && typeof sd.iso === "string" && inMonth(sd.iso)) {
      out.push({ iso: sd.iso, weight: weights.cluster_propagation });
    } else if (r.evidenceType === "ocr_date" && Array.isArray(sd.matches)) {
      for (const raw of sd.matches) {
        const m = raw as Record<string, unknown>;
        if (m && m.precision === "day" && typeof m.iso === "string" && inMonth(m.iso)) {
          const conf = typeof m.confidence === "number" ? m.confidence : 0.5;
          out.push({ iso: m.iso, weight: weights.ocr_date * conf });
        }
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}

function precisionFromSpan(span: number, sharpenable: boolean): Precision {
  if (span <= 1) return sharpenable ? "day" : "month";
  if (span <= 3) return "month";
  return "year";
}

function gatherDependsOn(rows: EvidenceRowInput[]): DependsOn {
  const personIds = new Set<string>();
  const factIds = new Set<string>();
  const modelVersions = new Set<string>();
  const neighborAssetIds = new Set<string>();
  for (const r of rows) {
    modelVersions.add(r.modelVersion);
    const sd = r.sourceDetail;
    if (Array.isArray(sd.persons)) {
      for (const p of sd.persons) {
        const pid = (p as Record<string, unknown>)?.personId;
        if (typeof pid === "string") personIds.add(pid);
      }
    }
    if (typeof sd.factId === "string") factIds.add(sd.factId);
    if (typeof sd.neighborAssetId === "string") neighborAssetIds.add(sd.neighborAssetId);
  }
  return {
    personIds: [...personIds],
    factIds: [...factIds],
    modelVersions: [...modelVersions],
    neighborAssetIds: [...neighborAssetIds],
  };
}

const COLD_START: Omit<InferenceResult, "dependsOn"> = {
  mapEstimate: null,
  mapPrecision: null,
  ciLow: null,
  ciHigh: null,
  confidence: 0,
  conflictFlag: false,
  conflictDetail: null,
  explanation: [],
  coldStart: true,
};

export function fuse(rows: EvidenceRowInput[], options: FuseOptions = {}): InferenceResult {
  const config = resolveConfig(options.config);
  const now = options.now ?? new Date();
  const grid = buildGrid(config.gridStartYear, config.gridStartMonth, now);

  const current = filterCurrentVersions(rows);

  const contribs: Contribution[] = [];
  const used: Array<{ row: EvidenceRowInput; L: number[] }> = [];
  for (const row of current) {
    const L = likelihoodFor(row, grid, config);
    if (!L) continue;
    const weight = config.weights[row.evidenceType] ?? 0;
    if (weight <= 0) continue;
    contribs.push({ weight, L });
    used.push({ row, L });
  }

  if (contribs.length === 0) {
    return { ...COLD_START, dependsOn: gatherDependsOn(current) };
  }

  const posterior = combinePosterior(contribs, grid, config);
  const mapCell = argmax(posterior);
  const hdi = hdiSet(posterior, config.hdiMass);
  const confidence = confidenceScore(posterior, mapCell, hdi, config);
  const { conflict, detail } = detectConflict(posterior, grid, options.storedCapturedAt ?? null, mapCell, config);

  // MAP estimate, day-sharpened when a tight HDI + an exact day source agree.
  const { year, month } = cellToYearMonth(grid, mapCell);
  const dayCands = dayCandidatesInMonth(current, config.weights, year, month);
  const sharpenable = hdi.spanMonths <= 1 && dayCands.length > 0;
  const mapPrecision = precisionFromSpan(hdi.spanMonths, sharpenable);
  const mapEstimate = sharpenable ? dayCands[0].iso : cellToIsoFirst(grid, mapCell);

  // Explanation ranked by how hard each row pushed toward the MAP.
  const explanation: ExplanationEntry[] = used
    .map(({ row, L }) => ({
      evidenceType: row.evidenceType,
      modelVersion: row.modelVersion,
      weight: config.weights[row.evidenceType] ?? 0,
      contribution: (config.weights[row.evidenceType] ?? 0) * Math.log(L[mapCell] + config.epsilon),
      detail: rowDetail(row),
    }))
    .sort((a, b) => b.contribution - a.contribution);

  return {
    mapEstimate,
    mapPrecision,
    ciLow: cellToIsoFirst(grid, hdi.loCell),
    ciHigh: cellToIsoFirst(grid, hdi.hiCell),
    confidence,
    conflictFlag: conflict,
    conflictDetail: detail,
    explanation,
    dependsOn: gatherDependsOn(current),
    coldStart: false,
  };
}

// Re-export the gate so consumers import the whole engine from one place.
export { gateDecision, DEFAULT_GATE_THRESHOLDS } from "./gate";
export type { GateAction, GateDecision } from "./gate";
// `isoToCell` / `dateToCell` are handy for callers that want to locate the
// stored date on the same grid; re-export to avoid deep imports.
export { isoToCell, dateToCell, buildGrid } from "./grid";
