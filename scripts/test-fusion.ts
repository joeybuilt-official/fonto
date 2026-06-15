// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 TDD harness for the PURE fusion engine + gate.
// DB-free + network-free. Run: pnpm test:fusion  (tsx scripts/test-fusion.ts)
//
// Covers the ADR-0003 synthetic cases: son-2014, conflicting-EXIF, season-only,
// single-hard-bound, empty cold-start, inferred-vs-confirmed weighting, plus the
// ADR-0005 per-action gate + ADR-0006 supersession + the day-sharpen.

import assert from "node:assert/strict";
import { fuse } from "../lib/fusion/fuse";
import { gateDecision } from "../lib/fusion/gate";
import type { EvidenceRowInput, EvidenceType } from "../lib/fusion/types";

const NOW = new Date("2026-06-15T00:00:00Z");
const T0 = new Date("2026-06-01T00:00:00Z");

function ev(
  evidenceType: EvidenceType,
  sourceDetail: Record<string, unknown>,
  modelVersion = "test@1",
  createdAt: Date = T0
): EvidenceRowInput {
  return { evidenceType, sourceDetail, modelVersion, createdAt };
}

let passed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

// ── son-2014: identity lower bound + a sharp EXIF date ───────────────────────
t("son-2014: exif pins the date inside the identity window", () => {
  const r = fuse(
    [
      ev("identity_bound", { lowerBound: "2004-01-01", upperBound: null, persons: [{ personId: "son" }] }),
      ev("exif", { iso: "2014-06-15", precision: "day", source: "DateTimeOriginal" }),
    ],
    { now: NOW }
  );
  assert.equal(r.coldStart, false);
  assert.ok(r.mapEstimate?.startsWith("2014-06"), `map=${r.mapEstimate}`);
  assert.equal(r.conflictFlag, false);
  assert.ok(r.confidence > 0.3, `conf=${r.confidence}`);
  assert.deepEqual(r.dependsOn.personIds, ["son"]);
});

// ── conflicting EXIF: stronger OCR disagrees with stored EXIF ─────────────────
t("conflicting-EXIF: OCR wins + stored date flags conflict", () => {
  const r = fuse(
    [
      ev("exif", { iso: "2014-06-15", precision: "day", source: "DateTimeOriginal" }),
      ev("ocr_date", { matches: [{ iso: "2018-03-10", precision: "day", confidence: 0.9 }] }),
    ],
    { now: NOW, storedCapturedAt: new Date("2014-06-15T00:00:00Z") }
  );
  assert.ok(r.mapEstimate?.startsWith("2018-03"), `map=${r.mapEstimate}`);
  assert.equal(r.conflictFlag, true);
  assert.equal(r.explanation[0].evidenceType, "ocr_date");
});

// ── season-only: a year-agnostic mask is low-confidence on its own ────────────
t("season-only: low confidence, wide interval", () => {
  const r = fuse([ev("scene_season", { months: [12, 1, 2], seasons: ["winter"] })], { now: NOW });
  assert.equal(r.coldStart, false);
  assert.ok(r.confidence < 0.2, `conf=${r.confidence}`);
  assert.equal(gateDecision({ score: r.confidence, action: "date" }), "leave");
});

// ── single hard bound: an open identity window alone is low-confidence ────────
t("single-hard-bound: identity-only is low confidence", () => {
  const r = fuse([ev("identity_bound", { lowerBound: "2010-01-01", upperBound: null })], { now: NOW });
  assert.equal(r.coldStart, false);
  assert.ok(r.confidence < 0.2, `conf=${r.confidence}`);
  assert.ok((r.ciLow ?? "") >= "2010-01-01", `ciLow=${r.ciLow}`);
});

// ── empty cold-start: no evidence → no crash, low confidence, leave ───────────
t("cold-start: empty evidence is safe + routes to leave", () => {
  const r = fuse([], { now: NOW });
  assert.equal(r.coldStart, true);
  assert.equal(r.mapEstimate, null);
  assert.equal(r.confidence, 0);
  assert.equal(gateDecision({ score: r.confidence, action: "date" }), "leave");
});

// ── inferred-vs-confirmed: a CONFIRMED neighbour date outweighs the mtime floor
t("propagation: confirmed cluster date beats the ingest floor", () => {
  const r = fuse(
    [
      ev("fs_mtime", { iso: "2020-01-01T00:00:00.000Z", source: "ingest_created_at" }),
      ev("cluster_propagation", { iso: "2015-07-01", confidence: 1, neighborAssetId: "n1" }),
    ],
    { now: NOW }
  );
  assert.ok(r.mapEstimate?.startsWith("2015-07"), `map=${r.mapEstimate}`);
  assert.deepEqual(r.dependsOn.neighborAssetIds, ["n1"]);
});

// ── supersession: only the latest model_version of a type is fused (ADR-0006) ─
t("supersession: newest exif model_version wins", () => {
  const r = fuse(
    [
      ev("exif", { iso: "2010-02-15", precision: "day" }, "exif@1", new Date("2026-01-01")),
      ev("exif", { iso: "2014-08-15", precision: "day" }, "exif@2", new Date("2026-06-01")),
    ],
    { now: NOW }
  );
  assert.ok(r.mapEstimate?.startsWith("2014-08"), `map=${r.mapEstimate}`);
});

// ── day-sharpen: a tight HDI + an exact day source yields day precision ───────
t("day-sharpen: sharp EXIF gives day precision + exact day", () => {
  const r = fuse([ev("exif", { iso: "2014-06-15", precision: "day", source: "DateTimeOriginal" })], { now: NOW });
  assert.equal(r.mapEstimate, "2014-06-15");
  assert.equal(r.mapPrecision, "day");
});

// ── gate: per-action thresholds (ADR-0005) ───────────────────────────────────
t("gate: date auto-commit / review / leave", () => {
  assert.equal(gateDecision({ score: 0.8, action: "date" }), "auto-commit");
  assert.equal(gateDecision({ score: 0.5, action: "date" }), "review");
  assert.equal(gateDecision({ score: 0.2, action: "date" }), "leave");
});

t("gate: any conflict on a date forces review even above HIGH", () => {
  assert.equal(gateDecision({ score: 0.99, action: "date", conflict: true }), "review");
});

t("gate: purge bar is far higher + needs structural verify", () => {
  assert.equal(gateDecision({ score: 0.8, action: "purge" }), "review");
  assert.equal(gateDecision({ score: 0.97, action: "purge", structurallyVerified: false }), "review");
  assert.equal(gateDecision({ score: 0.97, action: "purge", structurallyVerified: true }), "auto-commit");
});

console.log(`\n✓ ${passed} fusion assertions passed`);
