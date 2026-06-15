// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 2 TDD harness for the pure temporal helpers.
// DB-free. Run: pnpm test:temporal  (tsx scripts/test-temporal.ts)
//
// Convention: no vitest/jest in this repo — pure-logic units are exercised by
// tsx harnesses asserting with node:assert. Exit non-zero on first failure.

import assert from "node:assert/strict";
import {
  parsePartialDate,
  toRange,
  formatPartial,
  toColumns,
} from "../lib/temporal/precision";
import { parseRecurrence, expandYearly } from "../lib/temporal/recurrence";
import { validateFactInput } from "../lib/temporal/factInput";

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

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ── parsePartialDate ────────────────────────────────────────────────────────
t("parse year", () => {
  const p = parsePartialDate("2004");
  assert.ok(p);
  assert.equal(p.precision, "year");
  assert.equal(iso(p.date), "2004-01-01");
});

t("parse month", () => {
  const p = parsePartialDate("2014-08");
  assert.ok(p);
  assert.equal(p.precision, "month");
  assert.equal(iso(p.date), "2014-08-01");
});

t("parse day", () => {
  const p = parsePartialDate("2011-06-18");
  assert.ok(p);
  assert.equal(p.precision, "day");
  assert.equal(iso(p.date), "2011-06-18");
});

t("parse trims whitespace", () => {
  assert.equal(formatPartial(parsePartialDate("  2004 ")!), "2004");
});

t("parse rejects garbage", () => {
  for (const bad of ["", "abcd", "20-04", "2004/08", "2014-13", "2014-02-30", "999"]) {
    assert.equal(parsePartialDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

t("parse accepts leap day, rejects non-leap Feb 29", () => {
  assert.ok(parsePartialDate("2016-02-29")); // leap
  assert.equal(parsePartialDate("2015-02-29"), null); // not leap
});

// ── toRange ─────────────────────────────────────────────────────────────────
t("range year spans full year", () => {
  const r = toRange(parsePartialDate("2004")!);
  assert.equal(iso(r.start), "2004-01-01");
  assert.equal(iso(r.end), "2005-01-01");
});

t("range month spans the month", () => {
  const r = toRange(parsePartialDate("2014-08")!);
  assert.equal(iso(r.start), "2014-08-01");
  assert.equal(iso(r.end), "2014-09-01");
});

t("range month December wraps year", () => {
  const r = toRange(parsePartialDate("2014-12")!);
  assert.equal(iso(r.end), "2015-01-01");
});

t("range day spans one day", () => {
  const r = toRange(parsePartialDate("2011-06-18")!);
  assert.equal(iso(r.start), "2011-06-18");
  assert.equal(iso(r.end), "2011-06-19");
});

// ── format / columns round-trip ─────────────────────────────────────────────
t("format round-trips", () => {
  for (const s of ["2004", "2014-08", "2011-06-18"]) {
    assert.equal(formatPartial(parsePartialDate(s)!), s);
  }
});

t("toColumns yields yyyy-mm-dd + precision", () => {
  const c = toColumns(parsePartialDate("2004")!);
  assert.deepEqual(c, { date: "2004-01-01", precision: "year" });
  const c2 = toColumns(parsePartialDate("2014-08")!);
  assert.deepEqual(c2, { date: "2014-08-01", precision: "month" });
});

// ── parseRecurrence ─────────────────────────────────────────────────────────
t("parse Christmas yearly", () => {
  const r = parseRecurrence("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25");
  assert.deepEqual(r, { freq: "YEARLY", byMonth: 12, byMonthDay: 25, interval: 1 });
});

t("parse is case-insensitive + order-independent + RRULE prefix", () => {
  const r = parseRecurrence("RRULE:bymonthday=4;FREQ=yearly;BYMONTH=7");
  assert.deepEqual(r, { freq: "YEARLY", byMonth: 7, byMonthDay: 4, interval: 1 });
});

t("parse INTERVAL", () => {
  const r = parseRecurrence("FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1;INTERVAL=2");
  assert.equal(r?.interval, 2);
});

t("parse rejects non-yearly + incomplete + malformed", () => {
  for (const bad of [
    "FREQ=WEEKLY;BYDAY=MO",
    "FREQ=YEARLY;BYMONTH=12", // no day
    "FREQ=YEARLY;BYMONTHDAY=25", // no month
    "FREQ=YEARLY;BYMONTH=13;BYMONTHDAY=1", // bad month
    "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=99", // bad day
    "garbage",
    "",
  ]) {
    assert.equal(parseRecurrence(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ── expandYearly ────────────────────────────────────────────────────────────
t("expand Christmas across years", () => {
  const r = parseRecurrence("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25")!;
  const occ = expandYearly(r, 2010, 2013).map(iso);
  assert.deepEqual(occ, ["2010-12-25", "2011-12-25", "2012-12-25", "2013-12-25"]);
});

t("expand respects INTERVAL stride from anchor", () => {
  const r = parseRecurrence("FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;INTERVAL=2")!;
  const occ = expandYearly(r, 2010, 2015, 2010).map(iso);
  assert.deepEqual(occ, ["2010-01-01", "2012-01-01", "2014-01-01"]);
});

t("expand skips non-existent Feb 29 in non-leap years", () => {
  const r = parseRecurrence("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29")!;
  const occ = expandYearly(r, 2015, 2017).map(iso);
  assert.deepEqual(occ, ["2016-02-29"]); // 2015 + 2017 skipped
});

t("expand empty when range inverted", () => {
  const r = parseRecurrence("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25")!;
  assert.deepEqual(expandYearly(r, 2013, 2010), []);
});

// ── validateFactInput ───────────────────────────────────────────────────────
t("fact create: minimal trip", () => {
  const r = validateFactInput({ type: "trip", label: "Yellowstone" }, "create");
  assert.ok(r.ok);
  assert.equal(r.value.type, "trip");
  assert.equal(r.value.label, "Yellowstone");
});

t("fact create: partial dates split into columns", () => {
  const r = validateFactInput(
    { type: "trip", label: "Yellowstone", dateStart: "2014-08", dateEnd: "2014-08-20" },
    "create"
  );
  assert.ok(r.ok);
  assert.equal(r.value.dateStart, "2014-08-01");
  assert.equal(r.value.dateStartPrecision, "month");
  assert.equal(r.value.dateEnd, "2014-08-20");
  assert.equal(r.value.dateEndPrecision, "day");
});

t("fact create: recurring_event accepts YEARLY rrule", () => {
  const r = validateFactInput(
    { type: "recurring_event", label: "Christmas", recurrence: "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25" },
    "create"
  );
  assert.ok(r.ok);
  assert.equal(r.value.recurrence, "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25");
});

t("fact create: bad type rejected", () => {
  const r = validateFactInput({ type: "vacation", label: "x" }, "create");
  assert.equal(r.ok, false);
});

t("fact create: missing label rejected", () => {
  const r = validateFactInput({ type: "trip" }, "create");
  assert.equal(r.ok, false);
});

t("fact create: bad partial date rejected", () => {
  const r = validateFactInput({ type: "trip", label: "x", dateStart: "Aug 2014" }, "create");
  assert.equal(r.ok, false);
});

t("fact create: bad recurrence rejected", () => {
  const r = validateFactInput(
    { type: "recurring_event", label: "x", recurrence: "FREQ=WEEKLY" },
    "create"
  );
  assert.equal(r.ok, false);
});

t("fact create: personIds must be uuids", () => {
  const ok = validateFactInput(
    { type: "trip", label: "x", personIds: ["11111111-1111-1111-1111-111111111111"] },
    "create"
  );
  assert.ok(ok.ok);
  const bad = validateFactInput({ type: "trip", label: "x", personIds: ["not-a-uuid"] }, "create");
  assert.equal(bad.ok, false);
});

t("fact create: confidence range enforced", () => {
  assert.equal(validateFactInput({ type: "trip", label: "x", confidence: 2 }, "create").ok, false);
  assert.ok(validateFactInput({ type: "trip", label: "x", confidence: 0.5 }, "create").ok);
});

t("fact patch: single field, clears date with null", () => {
  const r = validateFactInput({ dateStart: null }, "patch");
  assert.ok(r.ok);
  assert.equal(r.value.dateStart, null);
  assert.equal(r.value.dateStartPrecision, null);
  assert.equal(r.value.type, undefined); // untouched
});

t("fact patch: empty body is valid no-op", () => {
  const r = validateFactInput({}, "patch");
  assert.ok(r.ok);
  assert.deepEqual(r.value, {});
});

console.log(`✓ temporal: ${passed} assertions passed`);
