// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-1 — GET /api/v1/stats.
//
// Single-shot workspace stats for the /home landing. Counts active
// assets bucketed by mime category, plus a couple of secondary tallies
// (favorites, "this month"). All buckets share the
// `assets_lifecycle_state_active_idx` partial index so the planner can
// satisfy each subquery from index data without touching the heap.
//
// Response:
//   {
//     "total": 1234,
//     "images": 900,
//     "documents": 200,
//     "videos": 12,
//     "other": 122,
//     "favorites": 48,
//     "thisMonth": 17
//   }

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { pgArray } from "@/lib/db/sql-helpers";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({
      total: 0,
      images: 0,
      documents: 0,
      videos: 0,
      other: 0,
      favorites: 0,
      thisMonth: 0,
      processing: 0,
    });
  }
  const workspaceId = workspaces[0].id;

  // Single SQL pull — counts all buckets at once via conditional
  // aggregates. Way cheaper than 7 separate queries when the workspace
  // grows. The partial lifecycle index covers the predicate.
  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      images: sql<number>`COUNT(*) FILTER (WHERE ${schema.assets.mimeType} LIKE 'image/%')::int`,
      documents: sql<number>`COUNT(*) FILTER (
        WHERE ${schema.assets.mimeType} LIKE 'text/%'
           OR ${schema.assets.mimeType} = 'application/pdf'
           OR ${schema.assets.mimeType} LIKE 'application/vnd.openxmlformats-officedocument.%'
           OR ${schema.assets.mimeType} = 'application/msword'
      )::int`,
      videos: sql<number>`COUNT(*) FILTER (WHERE ${schema.assets.mimeType} LIKE 'video/%')::int`,
      other: sql<number>`COUNT(*) FILTER (
        WHERE NOT (${schema.assets.mimeType} LIKE 'image/%'
              OR  ${schema.assets.mimeType} LIKE 'video/%'
              OR  ${schema.assets.mimeType} LIKE 'text/%'
              OR  ${schema.assets.mimeType} = 'application/pdf'
              OR  ${schema.assets.mimeType} LIKE 'application/vnd.openxmlformats-officedocument.%'
              OR  ${schema.assets.mimeType} = 'application/msword')
      )::int`,
      favorites: sql<number>`COUNT(*) FILTER (WHERE ${schema.assets.isFavorite} = true)::int`,
      thisMonth: sql<number>`COUNT(*) FILTER (
        WHERE ${schema.assets.createdAt} >= date_trunc('month', now())
      )::int`,
      processing: sql<number>`COUNT(*) FILTER (
        WHERE ${schema.assets.processingState} NOT IN ('ready', 'failed')
      )::int`,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        // ADR 0008 — scope default
        eq(schema.assets.scope, "PERSONAL")
      )
    );

  // M1 (P2a) — discovery badges. Best-effort; on failure we still return core stats.
  let pendingPeople = 0;
  let memoriesToday = 0;
  try {
    const [pendingRow] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(schema.persons)
      .where(
        and(
          eq(schema.persons.workspaceId, workspaceId),
          eq(schema.persons.hidden, false),
          sql`${schema.persons.name} IS NULL`
        )
      );
    pendingPeople = pendingRow?.c ?? 0;
  } catch {
    // persons table may not have rows yet — ignore
  }
  try {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const window = 3;
    const mm = String(month).padStart(2, "0");
    const mmddList: string[] = [];
    for (let d = day - window; d <= day + window; d++) {
      if (d < 1 || d > 31) continue;
      mmddList.push(`${mm}-${String(d).padStart(2, "0")}`);
    }
    if (mmddList.length) {
      const [memRow] = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(schema.assets)
        .where(
          sql`
            ${schema.assets.workspaceId} = ${workspaceId}
            AND ${schema.assets.lifecycleState} = 'active'
            AND ${schema.assets.scope} = 'PERSONAL'
            AND ${schema.assets.capturedAt} IS NOT NULL
            AND fonto.captured_mmdd_utc(${schema.assets.capturedAt}) = ANY(${pgArray(mmddList)}::text[])
            AND EXTRACT(YEAR FROM ${schema.assets.capturedAt} AT TIME ZONE 'UTC')
                < EXTRACT(YEAR FROM (CURRENT_DATE AT TIME ZONE 'UTC'))
          `
        );
      memoriesToday = memRow?.c ?? 0;
    }
  } catch {
    // functional index may not exist on fresh DB — ignore
  }

  return NextResponse.json({
    total: row?.total ?? 0,
    images: row?.images ?? 0,
    documents: row?.documents ?? 0,
    videos: row?.videos ?? 0,
    other: row?.other ?? 0,
    favorites: row?.favorites ?? 0,
    thisMonth: row?.thisMonth ?? 0,
    processing: row?.processing ?? 0,
    pendingPeople,
    memoriesToday,
  });
}
