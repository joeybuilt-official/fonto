// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core (ADR-0002/0003) — minimal RRULE expansion.
//
// `temporal_facts.recurrence` stores an iCalendar RRULE string. For photo
// dating the only recurrence that matters is the YEARLY one — annual holidays
// ("Christmas, every year"), anniversaries, recurring birthdays. So rather than
// pull in the full `rrule` dependency (a new top-level dep on a non-trivial
// project; CLAUDE.md §0.5/§9), we parse + expand exactly the YEARLY subset and
// reject the rest loudly. If a genuine need for weekly/monthly/COUNT/UNTIL
// recurrences appears, swap this for the `rrule` lib behind the same surface.
//
// Pure + DB-free → unit-testable (scripts/test-temporal.ts).

export interface YearlyRule {
  freq: "YEARLY";
  /** 1..12, the month the event recurs in. */
  byMonth: number;
  /** 1..31, the day of that month. */
  byMonthDay: number;
  /** INTERVAL=N → every N years. Default 1. */
  interval: number;
}

function int(v: string | undefined): number | null {
  if (v === undefined) return null;
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

/**
 * Parse "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25[;INTERVAL=N]" (case-insensitive,
 * order-independent, optional "RRULE:" prefix). Returns null on anything that
 * is not a well-formed YEARLY rule with both BYMONTH and BYMONTHDAY — callers
 * treat null as "not expandable, contributes no recurring evidence".
 */
export function parseRecurrence(rrule: string): YearlyRule | null {
  const body = rrule.trim().replace(/^RRULE:/i, "");
  if (!body) return null;

  const parts = new Map<string, string>();
  for (const seg of body.split(";")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) return null; // malformed segment
    parts.set(seg.slice(0, eq).trim().toUpperCase(), seg.slice(eq + 1).trim());
  }

  if (parts.get("FREQ")?.toUpperCase() !== "YEARLY") return null;

  const byMonth = int(parts.get("BYMONTH"));
  const byMonthDay = int(parts.get("BYMONTHDAY"));
  if (byMonth === null || byMonthDay === null) return null;
  if (byMonth < 1 || byMonth > 12) return null;
  if (byMonthDay < 1 || byMonthDay > 31) return null;

  const interval = parts.has("INTERVAL") ? int(parts.get("INTERVAL")) : 1;
  if (interval === null || interval < 1) return null;

  return { freq: "YEARLY", byMonth, byMonthDay, interval };
}

/**
 * Expand a YEARLY rule into the concrete UTC occurrence dates whose year falls
 * in [fromYear, toYear] inclusive. anchorYear seeds the INTERVAL stride (so
 * INTERVAL=2 from anchorYear hits every other year); default = fromYear.
 *
 * Days that don't exist in a given year (e.g. BYMONTHDAY=29 BYMONTH=2 on a
 * non-leap year) are SKIPPED, matching iCalendar RRULE semantics.
 */
export function expandYearly(
  rule: YearlyRule,
  fromYear: number,
  toYear: number,
  anchorYear?: number
): Date[] {
  if (toYear < fromYear) return [];
  const anchor = anchorYear ?? fromYear;
  const out: Date[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    if (((y - anchor) % rule.interval + rule.interval) % rule.interval !== 0) {
      continue;
    }
    const dt = new Date(Date.UTC(y, rule.byMonth - 1, rule.byMonthDay));
    // Skip non-existent dates (overflow rolled into the next month).
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === rule.byMonth - 1 &&
      dt.getUTCDate() === rule.byMonthDay
    ) {
      out.push(dt);
    }
  }
  return out;
}
