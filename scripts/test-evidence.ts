// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3 TDD harness for the PURE evidence logic (OCR-date
// parsing, season masks, the adapters' signal shaping, union-find). DB-free +
// network-free. Run: pnpm test:evidence  (tsx scripts/test-evidence.ts)
//
// Convention: no vitest/jest in this repo — pure-logic units are exercised by
// tsx harnesses asserting with node:assert. Exit non-zero on first failure.

import assert from "node:assert/strict";
import { parseOcrDates } from "../lib/evidence/ocrDates";
import { seasonMaskFromLabels } from "../lib/evidence/season";
import { UnionFind } from "../lib/evidence/unionFind";
import {
  identityEvidence,
  exifEvidence,
  filenameEvidence,
  fsMtimeEvidence,
  ocrDateEvidence,
  sceneSeasonEvidence,
} from "../lib/evidence/adapters";

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

// ── parseOcrDates ───────────────────────────────────────────────────────────
t("ocr: ISO full date", () => {
  const m = parseOcrDates("Taken on 2014-08-11 in the park");
  const day = m.find((x) => x.precision === "day");
  assert.ok(day);
  assert.equal(day.iso, "2014-08-11");
  assert.ok(day.confidence >= 0.85);
});

t("ocr: US numeric MM/DD/YYYY", () => {
  const m = parseOcrDates("12/25/2014");
  assert.ok(m.some((x) => x.iso === "2014-12-25" && x.precision === "day"));
});

t("ocr: EU numeric DD/MM/YYYY disambiguated by >12", () => {
  const m = parseOcrDates("25/12/2014");
  assert.ok(m.some((x) => x.iso === "2014-12-25" && x.precision === "day"));
});

t("ocr: month-name day year", () => {
  assert.ok(parseOcrDates("August 11, 2014").some((x) => x.iso === "2014-08-11"));
  assert.ok(parseOcrDates("11 Aug 2014").some((x) => x.iso === "2014-08-11"));
});

t("ocr: month-year only → month precision", () => {
  const m = parseOcrDates("Aug 2014");
  assert.ok(m.some((x) => x.iso === "2014-08" && x.precision === "month"));
});

t("ocr: bare year is low confidence (price noise)", () => {
  const m = parseOcrDates("Total $1999");
  const yr = m.find((x) => x.iso === "1999");
  assert.ok(yr);
  assert.equal(yr.precision, "year");
  assert.ok(yr.confidence <= 0.3);
});

t("ocr: implausible year rejected", () => {
  // 1850 is pre-photo window; nothing should parse.
  assert.equal(parseOcrDates("1850-01-01").length, 0);
});

t("ocr: dedup same normalised date", () => {
  const m = parseOcrDates("12/25/2014 and again Dec 25 2014");
  const days = m.filter((x) => x.iso === "2014-12-25");
  assert.equal(days.length, 1);
});

t("ocr: empty / dateless", () => {
  assert.equal(parseOcrDates("").length, 0);
  assert.equal(parseOcrDates("no dates here at all").length, 0);
});

t("ocr: sorted by confidence desc", () => {
  const m = parseOcrDates("2014-08-11 was the year 2014");
  for (let i = 1; i < m.length; i++) {
    assert.ok(m[i - 1].confidence >= m[i].confidence);
  }
});

// ── seasonMaskFromLabels ────────────────────────────────────────────────────
t("season: snow → winter months", () => {
  const mask = seasonMaskFromLabels(["snow", "mountain"]);
  assert.deepEqual(mask.months, [1, 2, 12]);
  assert.deepEqual(mask.seasons, ["winter"]);
});

t("season: beach → summer months", () => {
  assert.deepEqual(seasonMaskFromLabels(["beach", "sunny"]).months, [6, 7, 8]);
});

t("season: christmas holiday narrows to single month", () => {
  const mask = seasonMaskFromLabels(["christmas tree", "gifts"]);
  assert.deepEqual(mask.months, [12]);
});

t("season: holiday + season keyword stays narrowed", () => {
  const mask = seasonMaskFromLabels(["snow", "christmas tree"]);
  assert.deepEqual(mask.months, [12]);
  assert.deepEqual(mask.seasons, ["winter"]);
});

t("season: no seasonal labels → empty mask", () => {
  assert.deepEqual(seasonMaskFromLabels(["dog", "sofa"]).months, []);
});

// ── adapters ────────────────────────────────────────────────────────────────
t("identity: max-birth lower bound, min-death upper bound", () => {
  const ev = identityEvidence([
    { personId: "a", birthDate: "2004-01-01", birthPrecision: "year", deathDate: null, deathPrecision: null },
    { personId: "b", birthDate: "2010-06-01", birthPrecision: "month", deathDate: null, deathPrecision: null },
  ]);
  assert.ok(ev);
  assert.equal(ev.evidenceType, "identity_bound");
  assert.equal((ev.sourceDetail as Record<string, unknown>).lowerBound, "2010-06-01");
  assert.equal((ev.sourceDetail as Record<string, unknown>).upperBound, null);
});

t("identity: death narrows upper bound", () => {
  const ev = identityEvidence([
    { personId: "a", birthDate: "1950-01-01", birthPrecision: "year", deathDate: "1990-01-01", deathPrecision: "year" },
    { personId: "b", birthDate: "1960-01-01", birthPrecision: "year", deathDate: null, deathPrecision: null },
  ]);
  assert.ok(ev);
  const sd = ev.sourceDetail as Record<string, unknown>;
  assert.equal(sd.lowerBound, "1960-01-01");
  assert.equal(sd.upperBound, "1990-01-01");
});

t("identity: no dated person → no evidence", () => {
  assert.equal(
    identityEvidence([
      { personId: "a", birthDate: null, birthPrecision: null, deathDate: null, deathPrecision: null },
    ]),
    null
  );
});

t("exif: DateTimeOriginal preferred", () => {
  const ev = exifEvidence({
    DateTimeOriginal: "2014-08-11T10:00:00Z",
    CreateDate: "2020-01-01T00:00:00Z",
  });
  assert.ok(ev);
  assert.equal(ev.evidenceType, "exif");
  assert.equal((ev.sourceDetail as Record<string, unknown>).iso, "2014-08-11");
  assert.equal((ev.sourceDetail as Record<string, unknown>).source, "DateTimeOriginal");
});

t("exif: falls back to ModifyDate", () => {
  const ev = exifEvidence({ ModifyDate: "2014-08-11T10:00:00Z" });
  assert.ok(ev);
  assert.equal((ev.sourceDetail as Record<string, unknown>).source, "ModifyDate");
});

t("exif: implausible + null → no evidence", () => {
  assert.equal(exifEvidence({ DateTimeOriginal: "1900-01-01T00:00:00Z" }), null);
  assert.equal(exifEvidence(null), null);
});

t("filename: device pattern parsed", () => {
  const ev = filenameEvidence("IMG_20140811_100000.jpg");
  assert.ok(ev);
  assert.equal((ev.sourceDetail as Record<string, unknown>).iso, "2014-08-11");
});

t("filename: no date → no evidence", () => {
  assert.equal(filenameEvidence("vacation.jpg"), null);
});

t("fs_mtime: always emits ingest floor", () => {
  const ev = fsMtimeEvidence(new Date("2026-01-02T03:04:05Z"));
  assert.equal(ev.evidenceType, "fs_mtime");
  assert.equal((ev.sourceDetail as Record<string, unknown>).source, "ingest_created_at");
});

t("ocrDateEvidence: wraps matches / null on none", () => {
  const ev = ocrDateEvidence("shot 2014-08-11");
  assert.ok(ev);
  assert.equal(ev.evidenceType, "ocr_date");
  assert.ok(Array.isArray((ev.sourceDetail as Record<string, unknown>).matches));
  assert.equal(ocrDateEvidence("nothing here"), null);
});

t("sceneSeasonEvidence: stamps plexo model into version", () => {
  const ev = sceneSeasonEvidence(["snow"], "vlm-qwen2.5");
  assert.ok(ev);
  assert.equal(ev.evidenceType, "scene_season");
  assert.equal(ev.modelVersion, "scene-season@1/vlm-qwen2.5");
  assert.equal(sceneSeasonEvidence(["dog"], "vlm-qwen2.5"), null);
});

// ── UnionFind ───────────────────────────────────────────────────────────────
t("union-find: connected component, singleton excluded", () => {
  const uf = new UnionFind(["a", "b", "c", "d"]);
  uf.union("a", "b");
  uf.union("b", "c");
  const comps = uf.components(2);
  assert.equal(comps.length, 1);
  assert.deepEqual([...comps[0]].sort(), ["a", "b", "c"]);
});

t("union-find: two disjoint components", () => {
  const uf = new UnionFind(["a", "b", "c", "d"]);
  uf.union("a", "b");
  uf.union("c", "d");
  assert.equal(uf.components(2).length, 2);
});

console.log(`\n✓ ${passed} evidence assertions passed`);
