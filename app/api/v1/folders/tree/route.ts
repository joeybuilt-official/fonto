// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-2 — full folder tree in one shot.
//
// /api/v1/folders enumerates ONE level at a time (cheap, paginated by
// click). The left-rail tree on /app/folders wants the whole tree so it
// can render expand/collapse without a fetch per node. This endpoint
// answers that with a flat list of distinct directory_path values plus
// per-path counts — the client materialises the nested tree.
//
// Shape:
//   GET /api/v1/folders/tree
//   { paths: [ { path: "/Photos", assetCount: 42 }, ... ],
//     rootAssetCount: 7 }   // assets with directory_path IS NULL
//
// `paths` is ordered alphabetically. A workspace with a deeply nested
// tree can hit thousands of rows but each is ~40 bytes; a 1k-folder
// workspace fits in ~40KB which is fine for a single fetch.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export interface FolderTreeResponse {
  paths: Array<{ path: string; assetCount: number }>;
  rootAssetCount: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json<FolderTreeResponse>({ paths: [], rootAssetCount: 0 });
  }
  const { searchParams } = request.nextUrl;
  const requestedWorkspaceId = searchParams.get("workspaceId");
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // One row per distinct directory_path. Counts are leaf-level (assets
  // landing exactly at that path). Aggregate roll-ups are the client's
  // job since it already has every parent path in the same response.
  const rows = (await db.execute(sql`
    SELECT directory_path AS path, COUNT(*)::int AS asset_count
    FROM fonto.assets
    WHERE workspace_id = ${workspace.id}
      AND lifecycle_state = 'active'
      AND directory_path IS NOT NULL
    GROUP BY directory_path
    ORDER BY directory_path ASC
  `)) as unknown as Array<{ path: string; asset_count: number | string }>;

  const rootRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM fonto.assets
    WHERE workspace_id = ${workspace.id}
      AND lifecycle_state = 'active'
      AND directory_path IS NULL
  `)) as unknown as Array<{ c: number | string }>;

  return NextResponse.json<FolderTreeResponse>({
    paths: rows.map((r) => ({
      path: r.path,
      assetCount: Number(r.asset_count),
    })),
    rootAssetCount: Number(rootRows[0]?.c ?? 0),
  });
}
