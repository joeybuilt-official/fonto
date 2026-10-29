// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/tags/top — most-used tags across the caller's workspaces,
// each with an active-asset count and a sample asset id for a thumbnail.
// Backs the "Things" explore grid (auto labels + user tags surfaced as
// browseable tiles).
//
// T1.3' (docs/claude/platform/completed/perf-audit/perf-audit-plan.md) — class-B aggregate. Embeds per-tag asset
// counts so it's tagged BOTH `:tags` (so tag CRUD evicts) AND `:assets`
// (so asset CRUD / asset_tags link/unlink evicts). See CACHE-CONVENTION.md.

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { listTopTags } from "@/lib/tags/store";

const loadTopTags = (workspaceIds: string[], limit: number) => {
  const sortedIds = [...workspaceIds].sort();
  return unstable_cache(
    () => listTopTags(workspaceIds, limit),
    ["tags-top", sortedIds.join(","), String(limit)],
    {
      tags: sortedIds.flatMap((id) => [`ws:${id}:tags`, `ws:${id}:assets`]),
      revalidate: 300,
    }
  )();
};

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ tags: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const limitRaw = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "40", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 40;

  const rows = await loadTopTags(workspaceIds, limit);
  return NextResponse.json({ tags: rows });
}
