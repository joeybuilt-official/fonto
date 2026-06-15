// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0003). The monthly grid the posterior lives
// on. Cell i (0..size-1) maps to one calendar month from the configured start up
// to "now". Pure + DB-free.

export interface Grid {
  /** Absolute month number (year*12 + month0) of cell 0. */
  startAbs: number;
  /** Number of cells (months) inclusive. */
  size: number;
}

/** Absolute month index: year*12 + (month-1). month is 1..12. */
export function absMonth(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * Build the grid from (startYear, startMonth) through the month containing
 * `now`, inclusive. Always at least one cell.
 */
export function buildGrid(
  startYear: number,
  startMonth: number,
  now: Date
): Grid {
  const startAbs = absMonth(startYear, startMonth);
  const endAbs = absMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const size = Math.max(1, endAbs - startAbs + 1);
  return { startAbs, size };
}

/** Cell index for an absolute month, or null if outside the grid. */
export function absToCell(grid: Grid, abs: number): number | null {
  const i = abs - grid.startAbs;
  if (i < 0 || i >= grid.size) return null;
  return i;
}

/** Cell index for a Date (its calendar month), or null if outside the grid. */
export function dateToCell(grid: Grid, date: Date): number | null {
  return absToCell(grid, absMonth(date.getUTCFullYear(), date.getUTCMonth() + 1));
}

/** Cell index for an ISO date/partial ("YYYY", "YYYY-MM", "YYYY-MM-DD"). */
export function isoToCell(grid: Grid, iso: string): number | null {
  const m = iso.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  if (month < 1 || month > 12) return null;
  return absToCell(grid, absMonth(year, month));
}

/** Calendar (year, month 1..12) of a cell. */
export function cellToYearMonth(grid: Grid, cell: number): { year: number; month: number } {
  const abs = grid.startAbs + cell;
  return { year: Math.floor(abs / 12), month: (abs % 12) + 1 };
}

/** Calendar month 1..12 of a cell (year-agnostic — for season masks). */
export function cellMonth(grid: Grid, cell: number): number {
  return ((grid.startAbs + cell) % 12) + 1;
}

/** First-of-month ISO (YYYY-MM-01) for a cell. */
export function cellToIsoFirst(grid: Grid, cell: number): string {
  const { year, month } = cellToYearMonth(grid, cell);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}
