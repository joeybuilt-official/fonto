// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/tags/top — most-used tags across the caller's workspaces,
// each with an active-asset count and a sample asset id for a thumbnail.
// Backs the "Things" explore grid (auto labels + user tags surfaced as
// browseable tiles).

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ tags: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const limitRaw = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "40", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 40;

  const countExpr = sql<number>`count(distinct ${schema.assetTags.assetId})::int`;
  const rows = await db
    .select({
      id: schema.tags.id,
      name: schema.tags.name,
      color: schema.tags.color,
      aiSuggested: schema.tags.aiSuggested,
      count: countExpr,
      sampleAssetId: sql<
        string | null
      >`(array_agg(${schema.assetTags.assetId} ORDER BY ${schema.assetTags.addedAt} DESC))[1]`,
    })
    .from(schema.tags)
    .innerJoin(schema.assetTags, eq(schema.assetTags.tagId, schema.tags.id))
    .innerJoin(schema.assets, eq(schema.assets.id, schema.assetTags.assetId))
    .where(
      and(
        inArray(schema.tags.workspaceId, workspaceIds),
        eq(schema.assets.lifecycleState, "active")
      )
    )
    .groupBy(schema.tags.id)
    .orderBy(desc(countExpr))
    .limit(limit);

  return NextResponse.json({ tags: rows });
}
