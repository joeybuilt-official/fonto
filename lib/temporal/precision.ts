// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core (ADR-0002/0003) — partial-date handling.
//
// A "partial date" is how the fact base stores human-supplied dates that are
// only known to year, month, or day precision ("born 2004", "trip in Aug 2014",
// "wedding 2011-06-18"). It is a (date, precision) pair where `date` is
// normalised to the FIRST instant of the period it covers, and `precision`
// names how wide that period is. `toRange` expands the pair to a half-open
// [start, end) span — which is exactly what the fusion engine integrates over
// when it turns a fact into a monthly-grid likelihood.
//
// Pure + DB-free so it is unit-testable in isolation (scripts/test-temporal.ts).

export type Precision = "year" | "month" | "day";

export interface PartialDate {
  /** UTC date normalised to the first instant of the period. */
  date: Date;
  precision: Precision;
}

const YEAR_RE = /^(\d{4})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utc(y: number, m: number, d: number): Date {
  // m is 1-based here for readability; Date.UTC wants 0-based month.
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function valid(y: number, m: number, d: number): boolean {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = utc(y, m, d);
  // Reject overflow (e.g. 2014-02-30 → March): the round-trip must match.
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Parse "2004" | "2004-08" | "2004-08-11" into a normalised PartialDate.
 * Returns null on anything malformed or out of range. Whitespace tolerated.
 */
export function parsePartialDate(input: string): PartialDate | null {
  const s = input.trim();
  let m: RegExpMatchArray | null;

  if ((m = s.match(DAY_RE))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!valid(y, mo, d)) return null;
    return { date: utc(y, mo, d), precision: "day" };
  }
  if ((m = s.match(MONTH_RE))) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (!valid(y, mo, 1)) return null;
    return { date: utc(y, mo, 1), precision: "month" };
  }
  if ((m = s.match(YEAR_RE))) {
    const y = Number(m[1]);
    if (!valid(y, 1, 1)) return null;
    return { date: utc(y, 1, 1), precision: "year" };
  }
  return null;
}

/**
 * The half-open [start, end) span a PartialDate covers.
 *   year  2004        -> 2004-01-01 .. 2005-01-01
 *   month 2014-08     -> 2014-08-01 .. 2014-09-01
 *   day   2011-06-18  -> 2011-06-18 .. 2011-06-19
 */
export function toRange(p: PartialDate): { start: Date; end: Date } {
  const y = p.date.getUTCFullYear();
  const mo = p.date.getUTCMonth() + 1;
  const d = p.date.getUTCDate();
  const start = p.date;
  let end: Date;
  switch (p.precision) {
    case "year":
      end = utc(y + 1, 1, 1);
      break;
    case "month":
      end = mo === 12 ? utc(y + 1, 1, 1) : utc(y, mo + 1, 1);
      break;
    case "day":
      end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      break;
  }
  return { start, end };
}

/** Canonical string form, round-trips through parsePartialDate. */
export function formatPartial(p: PartialDate): string {
  const y = String(p.date.getUTCFullYear()).padStart(4, "0");
  const mo = String(p.date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(p.date.getUTCDate()).padStart(2, "0");
  switch (p.precision) {
    case "year":
      return y;
    case "month":
      return `${y}-${mo}`;
    case "day":
      return `${y}-${mo}-${d}`;
  }
}

/**
 * Split a PartialDate into the DB column pair (ISO yyyy-mm-dd date string +
 * precision), matching the `*_date` / `*_precision` columns. Drizzle's `date`
 * column type takes a yyyy-mm-dd string.
 */
export function toColumns(p: PartialDate): { date: string; precision: Precision } {
  const y = String(p.date.getUTCFullYear()).padStart(4, "0");
  const mo = String(p.date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(p.date.getUTCDate()).padStart(2, "0");
  return { date: `${y}-${mo}-${d}`, precision: p.precision };
}
