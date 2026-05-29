// SPDX-License-Identifier: AGPL-3.0-only
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
        eq(schema.assets.lifecycleState, "active")
      )
    );

  return NextResponse.json({
    total: row?.total ?? 0,
    images: row?.images ?? 0,
    documents: row?.documents ?? 0,
    videos: row?.videos ?? 0,
    other: row?.other ?? 0,
    favorites: row?.favorites ?? 0,
    thisMonth: row?.thisMonth ?? 0,
    processing: row?.processing ?? 0,
  });
}
