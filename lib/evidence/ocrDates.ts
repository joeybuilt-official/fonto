// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. Parse dates out of OCR text (assets.ocr_text).
// Pure + DB-free so it is unit-testable in isolation.
//
// OCR dates are a SHARP evidence type (a date printed on a photo, a receipt, a
// document is usually the real date) but the source text is noisy — prices,
// counts, phone numbers all look year-ish. We therefore:
//   - accept full dates + month-year strings with HIGH confidence,
//   - accept bare 4-digit years only inside the plausible-photo window
//     (1995..nextYear) and at LOW confidence (Phase 4 down-weights them),
//   - normalise everything to a (iso, precision) partial date matching the rest
//     of the date model (lib/temporal/precision.ts).

import type { Precision } from "@/lib/temporal/precision";

export interface OcrDateMatch {
  /** The raw substring that matched, for the evidence artifact. */
  raw: string;
  /** Normalised partial date: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'. */
  iso: string;
  precision: Precision;
  /** 0..1 — how trustworthy this match is as a real date (not a stray number). */
  confidence: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12,
  december: 12,
};

function plausibleYear(y: number): boolean {
  return y >= 1995 && y <= new Date().getUTCFullYear() + 1;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Extract every plausible date from OCR text. Deduplicates on the normalised
 * (iso, precision) so "12/25/2014" and "Dec 25 2014" in the same caption don't
 * double-count. Ordered by confidence desc. Returns [] for empty/dateless text.
 */
export function parseOcrDates(text: string | null | undefined): OcrDateMatch[] {
  if (!text) return [];
  const out: OcrDateMatch[] = [];
  const seen = new Set<string>();

  const push = (m: OcrDateMatch) => {
    const key = `${m.iso}|${m.precision}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  // ISO-ish: 2014-08-11 / 2014/08/11 / 2014.08.11
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (plausibleYear(y) && validYmd(y, mo, d)) {
      push({ raw: m[0], iso: `${y}-${pad(mo)}-${pad(d)}`, precision: "day", confidence: 0.9 });
    }
  }

  // US/EU numeric: 12/25/2014 or 25/12/2014. Ambiguous DD vs MM — when one field
  // is >12 it disambiguates; otherwise assume MM/DD (US) but drop to month
  // precision is overkill, so keep day with slightly lower confidence.
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (!plausibleYear(y)) continue;
    let mo: number, d: number;
    if (a > 12 && b <= 12) { d = a; mo = b; }
    else if (b > 12 && a <= 12) { mo = a; d = b; }
    else { mo = a; d = b; } // ambiguous → assume MM/DD
    if (validYmd(y, mo, d)) {
      const conf = a > 12 || b > 12 ? 0.85 : 0.7; // unambiguous vs assumed order
      push({ raw: m[0], iso: `${y}-${pad(mo)}-${pad(d)}`, precision: "day", confidence: conf });
    }
  }

  // Month-name day, year: "August 11, 2014" / "Aug 11 2014" / "11 Aug 2014".
  const monthAlt = Object.keys(MONTHS).join("|");
  const mdY = new RegExp(`\\b(${monthAlt})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(mdY)) {
    const mo = MONTHS[m[1].toLowerCase()], d = +m[2], y = +m[3];
    if (mo && plausibleYear(y) && validYmd(y, mo, d)) {
      push({ raw: m[0], iso: `${y}-${pad(mo)}-${pad(d)}`, precision: "day", confidence: 0.85 });
    }
  }
  const dMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})\\.?,?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(dMY)) {
    const d = +m[1], mo = MONTHS[m[2].toLowerCase()], y = +m[3];
    if (mo && plausibleYear(y) && validYmd(y, mo, d)) {
      push({ raw: m[0], iso: `${y}-${pad(mo)}-${pad(d)}`, precision: "day", confidence: 0.85 });
    }
  }

  // Month-name year only: "August 2014" / "Aug 2014".
  const mY = new RegExp(`\\b(${monthAlt})\\.?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(mY)) {
    const mo = MONTHS[m[1].toLowerCase()], y = +m[2];
    if (mo && plausibleYear(y)) {
      push({ raw: m[0], iso: `${y}-${pad(mo)}`, precision: "month", confidence: 0.6 });
    }
  }

  // Bare 4-digit year — noisy; LOW confidence, plausible window only.
  for (const m of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    const y = +m[0];
    if (plausibleYear(y)) {
      push({ raw: m[0], iso: `${y}`, precision: "year", confidence: 0.25 });
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
