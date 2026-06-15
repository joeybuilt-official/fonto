// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core (ADR-0002) — temporal_facts authoring input validation.
//
// Pure validator shared by POST + PATCH /api/v1/temporal-facts. Turns an
// untrusted JSON body into a clean DB-ready patch (partial-date strings split
// into date + precision columns) or a typed error string. DB-free + testable.

import { parsePartialDate, toColumns } from "./precision";
import { parseRecurrence } from "./recurrence";

export const FACT_TYPES = [
  "residence",
  "trip",
  "event",
  "recurring_event",
  "life_milestone",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DB-ready columns for a temporal_facts insert/update (origin set by route). */
export interface FactColumns {
  type?: FactType;
  label?: string;
  dateStart?: string | null;
  dateStartPrecision?: string | null;
  dateEnd?: string | null;
  dateEndPrecision?: string | null;
  recurrence?: string | null;
  locationLabel?: string | null;
  personIds?: string[];
  confidence?: number;
}

export type ValidateResult =
  | { ok: true; value: FactColumns }
  | { ok: false; error: string };

interface RawBody {
  type?: unknown;
  label?: unknown;
  dateStart?: unknown;
  dateEnd?: unknown;
  recurrence?: unknown;
  locationLabel?: unknown;
  personIds?: unknown;
  confidence?: unknown;
}

/**
 * `mode: "create"` requires type + label; `mode: "patch"` validates only the
 * keys present (so a PATCH can touch one field). A partial date may be cleared
 * by sending null; sending a malformed string is an error.
 */
export function validateFactInput(
  body: RawBody,
  mode: "create" | "patch"
): ValidateResult {
  const out: FactColumns = {};

  // type
  if (mode === "create" || "type" in body) {
    if (typeof body.type !== "string" || !FACT_TYPES.includes(body.type as FactType)) {
      return { ok: false, error: `type must be one of ${FACT_TYPES.join(", ")}` };
    }
    out.type = body.type as FactType;
  }

  // label
  if (mode === "create" || "label" in body) {
    if (typeof body.label !== "string" || !body.label.trim()) {
      return { ok: false, error: "label must be a non-empty string" };
    }
    out.label = body.label.trim().slice(0, 300);
  }

  // partial dates
  for (const [key, dateCol, precCol] of [
    ["dateStart", "dateStart", "dateStartPrecision"],
    ["dateEnd", "dateEnd", "dateEndPrecision"],
  ] as const) {
    if (!(key in body)) continue;
    const v = (body as Record<string, unknown>)[key];
    if (v === null || v === "") {
      out[dateCol] = null;
      out[precCol] = null;
      continue;
    }
    if (typeof v !== "string") return { ok: false, error: `${key} must be a date string or null` };
    const parsed = parsePartialDate(v);
    if (!parsed) return { ok: false, error: `${key} is not a valid partial date (YYYY | YYYY-MM | YYYY-MM-DD)` };
    const cols = toColumns(parsed);
    out[dateCol] = cols.date;
    out[precCol] = cols.precision;
  }

  // recurrence (only meaningful for recurring_event; validate the subset)
  if ("recurrence" in body) {
    const v = body.recurrence;
    if (v === null || v === "") {
      out.recurrence = null;
    } else if (typeof v === "string" && parseRecurrence(v)) {
      out.recurrence = v.trim();
    } else {
      return {
        ok: false,
        error: "recurrence must be a YEARLY RRULE (FREQ=YEARLY;BYMONTH=..;BYMONTHDAY=..) or null",
      };
    }
  }

  // locationLabel
  if ("locationLabel" in body) {
    const v = body.locationLabel;
    if (v === null || v === "") out.locationLabel = null;
    else if (typeof v === "string") out.locationLabel = v.trim().slice(0, 300);
    else return { ok: false, error: "locationLabel must be a string or null" };
  }

  // personIds
  if ("personIds" in body) {
    if (!Array.isArray(body.personIds) || !body.personIds.every((p) => typeof p === "string" && UUID_RE.test(p))) {
      return { ok: false, error: "personIds must be an array of uuids" };
    }
    out.personIds = Array.from(new Set(body.personIds as string[]));
  }

  // confidence
  if ("confidence" in body) {
    const v = body.confidence;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, error: "confidence must be a number in [0,1]" };
    }
    out.confidence = v;
  }

  return { ok: true, value: out };
}
