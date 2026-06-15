// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/collections/stats
// Returns item counts for all utility collection tiles on the
// Collections screen (Favorites, Trash, Screenshots, Archive, Documents).
// Five parallel COUNT queries, all hitting partial indexes — fast at
// any library size the partial indexes cover.
//
// T1.3' (fonto-perf-audit.md) — class-B aggregate. Counts come from
// `fonto.assets` so every asset-side mutation evicts via `ws:<id>:assets`;
// the `ws:<id>:collections` tag is also fired for symmetry w/ the rest of
// the Collections surface. See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { and, count, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

interface CollectionsStats {
  favorites: number;
  trash: number;
  screenshots: number;
  archived: number;
  documents: number;
}

const loadCollectionsStats = (workspaceIds: string[]) => {
  const sortedIds = [...workspaceIds].sort();
  return unstable_cache(
    async (): Promise<CollectionsStats> => {
      const [favRow, trashRow, screenshotRow, archiveRow, docRow] = await Promise.all([
        // ADR 0008 — scope default on every count
        db
          .select({ c: count() })
          .from(schema.assets)
          .where(and(inArray(schema.assets.workspaceId, workspaceIds), eq(schema.assets.isFavorite, true), eq(schema.assets.lifecycleState, "active"), eq(schema.assets.scope, "PERSONAL"))),
        db
          .select({ c: count() })
          .from(schema.assets)
          .where(and(inArray(schema.assets.workspaceId, workspaceIds), eq(schema.assets.lifecycleState, "trashed"), eq(schema.assets.scope, "PERSONAL"))),
        db
          .select({ c: count() })
          .from(schema.assets)
          .where(and(inArray(schema.assets.workspaceId, workspaceIds), eq(schema.assets.kind, "screenshot"), eq(schema.assets.lifecycleState, "active"), eq(schema.assets.scope, "PERSONAL"))),
        db
          .select({ c: count() })
          .from(schema.assets)
          .where(and(inArray(schema.assets.workspaceId, workspaceIds), eq(schema.assets.lifecycleState, "archived"), eq(schema.assets.scope, "PERSONAL"))),
        db
          .select({ c: count() })
          .from(schema.assets)
          .where(and(inArray(schema.assets.workspaceId, workspaceIds), eq(schema.assets.kind, "document"), eq(schema.assets.lifecycleState, "active"), eq(schema.assets.scope, "PERSONAL"))),
      ]);

      return {
        favorites: Number(favRow[0]?.c ?? 0),
        trash: Number(trashRow[0]?.c ?? 0),
        screenshots: Number(screenshotRow[0]?.c ?? 0),
        archived: Number(archiveRow[0]?.c ?? 0),
        documents: Number(docRow[0]?.c ?? 0),
      };
    },
    ["collections-stats", sortedIds.join(",")],
    {
      tags: sortedIds.flatMap((id) => [`ws:${id}:collections`, `ws:${id}:assets`]),
      revalidate: 300,
    },
  )();
};

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ favorites: 0, trash: 0, screenshots: 0, archived: 0, documents: 0 });
  }
  const wsIds = workspaces.map((w) => w.id);

  const stats = await loadCollectionsStats(wsIds);
  return NextResponse.json(stats);
}
