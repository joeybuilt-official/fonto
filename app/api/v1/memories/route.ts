// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.3 — Memories ("On this day").
//
// Returns every active asset whose `captured_at` falls on the same calendar
// day (MM-DD, ±N days fuzz) as the requested date in any prior year. The
// result is grouped by year so the UI can render each year as its own
// section / carousel slide.
//
// Query shape (matches migration 0023's functional index on
// (workspace_id, fonto.captured_mmdd_utc(captured_at)) WHERE active + NOT NULL):
//
//   WHERE workspace_id = $ws
//     AND lifecycle_state = 'active'
//     AND captured_at IS NOT NULL
//     AND fonto.captured_mmdd_utc(captured_at) = ANY($mmddList::text[])
//     AND EXTRACT(YEAR FROM captured_at AT TIME ZONE 'UTC')
//         < EXTRACT(YEAR FROM (CURRENT_DATE AT TIME ZONE 'UTC'))
//   ORDER BY captured_at DESC
//   LIMIT 200
//
// $mmddList is the precomputed set of valid MM-DD strings within the ±window
// fuzz around the requested date (e.g. for 2026-05-24 window=3, the array is
// {'05-21','05-22','05-23','05-24','05-25','05-26','05-27'}). Wrap-around
// across month boundaries is intentionally NOT handled — Jan 1 won't pull in
// Dec 30. Out-of-range days (e.g. day=30, window=3 -> 33) are silently
// skipped.
//
// `window` defaults to MEMORIES_DAY_WINDOW (=3); `MEMORIES_MAX_PER_YEAR`
// (=50) caps the per-year list size after grouping so a heavy year doesn't
// dominate the response.
//
// Auth: viewer (read-only over the caller's primary workspace, same scoping
// as `GET /api/v1/assets`).
//
// TODO(v2): cluster results into CLIP-similar event groups inside 24h
// windows ("trip to Iceland day 3") — see the Phase 5 plan's "v2 cluster
// CLIP within 24h windows for event detection" note. Will live behind a
// separate route or response field; keep this endpoint's shape stable.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { pgArray } from "@/lib/db/sql-helpers";
import { serializeAsset } from "@/lib/assets/createAssetRow";

// Day-of-year fuzz window. ±3 means "May 23 also pulls in May 20..May 26".
// Wrap-around across month boundaries is intentionally NOT handled — Jan 1
// won't include Dec 30 from the previous year. That edge case is rare and
// the alternative (computing day-of-year arithmetic in SQL) is more code
// than it's worth for the V1.
const DEFAULT_DAY_WINDOW = 3;

/** Generate the MM-DD strings inside the ±window fuzz around (month, day). */
function buildMmddList(month: number, day: number, window: number): string[] {
  const mm = String(month).padStart(2, "0");
  const out: string[] = [];
  for (let d = day - window; d <= day + window; d++) {
    if (d < 1 || d > 31) continue;
    out.push(`${mm}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

// Hard upper cap per year, after the SQL LIMIT 200 fans out. Stops a single
// "wedding day, took 800 photos" year from drowning every other year's
// thumbnail in the carousel.
const DEFAULT_MAX_PER_YEAR = 50;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse `YYYY-MM-DD`; returns null on malformed input. */
function parseDate(raw: string | null): { month: number; day: number } | null {
  if (!raw) {
    const now = new Date();
    return { month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const month = Number.parseInt(m[2], 10);
  const day = Number.parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

export interface MemoryAsset {
  id: string;
  filename: string;
  mimeType: string;
  thumbnailKey: string | null;
  capturedAt: string | null;
}

export interface MemoryYear {
  year: number;
  /** Number of assets the year contains in the window (pre-cap). */
  count: number;
  /** Asset rows, capped at MEMORIES_MAX_PER_YEAR. */
  assets: Array<ReturnType<typeof serializeAsset>>;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ years: [] });
  }
  const workspaceId = workspaces[0].id;

  const { searchParams } = request.nextUrl;
  const parsed = parseDate(searchParams.get("date"));
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid date — expected YYYY-MM-DD." },
      { status: 400 }
    );
  }
  const { month, day } = parsed;

  const dayWindow = readIntEnv("MEMORIES_DAY_WINDOW", DEFAULT_DAY_WINDOW);
  const maxPerYear = readIntEnv("MEMORIES_MAX_PER_YEAR", DEFAULT_MAX_PER_YEAR);
  const mmddList = buildMmddList(month, day, dayWindow);
  if (mmddList.length === 0) {
    return NextResponse.json({ years: [] });
  }

  // The functional index from migration 0023 covers
  // (workspace_id, fonto.captured_mmdd_utc(captured_at)) with the partial
  // predicate `lifecycle_state='active' AND captured_at IS NOT NULL`. Using
  // `= ANY($mmddList::text[])` matches the IMMUTABLE function expression
  // verbatim so the planner picks the index; the year predicate is a cheap
  // residual filter on the heap.
  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      sql`
        ${schema.assets.workspaceId} = ${workspaceId}
        AND ${schema.assets.lifecycleState} = 'active'
        AND ${schema.assets.capturedAt} IS NOT NULL
        AND fonto.captured_mmdd_utc(${schema.assets.capturedAt}) = ANY(${pgArray(mmddList)}::text[])
        AND EXTRACT(YEAR FROM ${schema.assets.capturedAt} AT TIME ZONE 'UTC')
            < EXTRACT(YEAR FROM (CURRENT_DATE AT TIME ZONE 'UTC'))
      `
    )
    .orderBy(sql`${schema.assets.capturedAt} desc`)
    .limit(200);

  // Group by year. JS-side: 200 rows is trivial, no need to push GROUP BY
  // into Postgres (and pulling the row payload still requires this fan-out
  // for the carousel preview anyway).
  const byYear = new Map<number, ReturnType<typeof serializeAsset>[]>();
  for (const row of rows) {
    if (!row.capturedAt) continue;
    const year = new Date(row.capturedAt).getUTCFullYear();
    const bucket = byYear.get(year);
    if (bucket) bucket.push(serializeAsset(row));
    else byYear.set(year, [serializeAsset(row)]);
  }

  const years: MemoryYear[] = Array.from(byYear.entries())
    .map(([year, assets]) => ({
      year,
      count: assets.length,
      assets: assets.slice(0, maxPerYear),
    }))
    // Newest year first so "1 year ago" is at the top.
    .sort((a, b) => b.year - a.year);

  return NextResponse.json({ years });
}
