// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.5 — virtual folder listing.
//
// Folders in Fonto are not rows. They're prefixes of `assets.directory_path`
// (see `lib/folders/normalize.ts` for the canonical shape). This endpoint
// answers "what's inside `/Photos/2024`?":
//
//   - Sub-folders: the distinct first segment after `prefix/` in every
//     descendant asset's `directory_path`, with an asset count rolled up.
//   - `assetsAtThisLevel`: how many assets sit *exactly* at `prefix` (i.e.
//     `directory_path = prefix`).
//
// The query is two cheap index scans on `assets_workspace_directory_path_idx`
// — one GROUP BY for sub-folders, one COUNT for the level itself. No
// recursion, no `folders` table.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";

export interface FolderListing {
  prefix: string;
  folders: Array<{
    name: string;
    path: string;
    assetCount: number;
  }>;
  assetsAtThisLevel: number;
}

/**
 * Coerce the `?prefix=` query into something we can safely embed in the
 * SQL `LIKE` operand. Empty prefix means "list top-level folders" — we use
 * an empty string and the substring math still works (`substring(p FROM 2)`
 * = the whole path minus the leading `/`).
 */
function resolvePrefix(raw: string | null): string {
  if (!raw) return "";
  const norm = normalizeDirectoryPath(raw);
  return norm ?? "";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const prefix = resolvePrefix(searchParams.get("prefix"));

  // Resolve workspace: prefer ?workspaceId if provided + accessible, else
  // fall back to the user's first workspace (mirrors GET /api/v1/assets).
  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json<FolderListing>(
      { prefix, folders: [], assetsAtThisLevel: 0 },
      { status: 200 }
    );
  }

  const requestedWorkspaceId = searchParams.get("workspaceId");
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // Subfolders: GROUP BY the first segment after `prefix/`. For the empty
  // prefix case (root) we strip the leading `/` by starting at offset 2 in
  // postgres terms (substring is 1-indexed, +1 for the leading `/`).
  //
  // - `LIKE 'prefix/%'` — every row strictly under `prefix`.
  // - `substring(directory_path FROM len(prefix) + 2)` — the suffix after
  //   `prefix/`.
  // - `split_part(..., '/', 1)` — the immediate child segment.
  //
  // Examples (prefix=`/Photos`):
  //   /Photos/2024            -> "2024"
  //   /Photos/2024/Iceland    -> "2024"
  //   /Photos/2023/Trip       -> "2023"
  //   /Documents/Taxes        -> not matched (LIKE filter excludes)
  const prefixLikeOperand = prefix === "" ? "/%" : `${prefix}/%`;
  const offsetIntoPath = prefix.length + 2; // len(prefix) + len("/") + 1 (1-indexed)

  const folderRows = (await db.execute(sql`
    SELECT
      split_part(substring(directory_path FROM ${offsetIntoPath}), '/', 1) AS name,
      COUNT(*)::int AS asset_count
    FROM fonto.assets
    WHERE workspace_id = ${workspace.id}
      AND lifecycle_state = 'active'
      AND directory_path IS NOT NULL
      AND directory_path LIKE ${prefixLikeOperand}
    GROUP BY name
    HAVING split_part(substring(directory_path FROM ${offsetIntoPath}), '/', 1) <> ''
    ORDER BY name ASC
  `)) as unknown as Array<{ name: string; asset_count: number | string }>;

  const folders = folderRows
    .filter((r) => typeof r.name === "string" && r.name.length > 0)
    .map((r) => ({
      name: r.name,
      path: prefix === "" ? `/${r.name}` : `${prefix}/${r.name}`,
      assetCount: Number(r.asset_count),
    }));

  // Assets sitting exactly at this level. For the root, that's rows where
  // directory_path is null — our normaliser never writes empty/`/` so the
  // only way for an asset to land at the workspace root is via NULL. For a
  // nested prefix it's rows whose `directory_path = prefix` exactly.
  let assetsAtThisLevel = 0;
  if (prefix === "") {
    const rootRows = (await db.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM fonto.assets
      WHERE workspace_id = ${workspace.id}
        AND lifecycle_state = 'active'
        AND directory_path IS NULL
    `)) as unknown as Array<{ c: number | string }>;
    assetsAtThisLevel = Number(rootRows[0]?.c ?? 0);
  } else {
    const levelRows = (await db.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM fonto.assets
      WHERE workspace_id = ${workspace.id}
        AND lifecycle_state = 'active'
        AND directory_path = ${prefix}
    `)) as unknown as Array<{ c: number | string }>;
    assetsAtThisLevel = Number(levelRows[0]?.c ?? 0);
  }

  const body: FolderListing = {
    prefix,
    folders,
    assetsAtThisLevel,
  };
  return NextResponse.json(body);
}
