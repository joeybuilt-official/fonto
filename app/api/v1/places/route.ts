// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/places
// Returns place groups derived from reverse-geocoded `place_name` on assets.
// Each group: { placeName, count, previewIds[] } — up to 4 preview asset IDs
// for building the thumbnail mosaic on the Places card.
// Minimum 3 assets per place (PLACES_MIN_ASSETS env var, default 3).
// Ordered by asset count DESC (most-photographed places first).
// Requires migration 0037 (assets_workspace_placename_idx) for fast GROUP BY.
//
// T1.3' (docs/claude/platform/completed/perf-audit/perf-audit-plan.md) — class-B aggregate. Wholly derived from
// `fonto.assets` (no places table), so the cache key is the sorted workspace
// id list and the tag list is per-workspace `:places` (synthetic — no mutation
// route owns it) + `:assets` (which every asset-side mutation must fire).
// See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db } from "@/lib/db";

export interface PlaceGroup {
  placeName: string;
  count: number;
  previewIds: string[];
}

const MIN_ASSETS = parseInt(process.env.PLACES_MIN_ASSETS ?? "3", 10);

const loadPlaces = (workspaceIds: string[]) => {
  const sortedIds = [...workspaceIds].sort();
  return unstable_cache(
    async (): Promise<PlaceGroup[]> => {
      // One query: group by place_name, aggregate count + array of up to 4 IDs.
      // Uses the assets_workspace_placename_idx partial index.
      //
      // Build the IN-list inline via sql.join so a single-element wsIds doesn't
      // get unwrapped by the postgres driver into a scalar (which would fail
      // against the WHERE column's uuid[] cast). drizzle's `${arr}::uuid[]`
      // path passes through pg's array protocol unreliably on single elements.
      const wsList = sql.join(
        sortedIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const rows = (await db.execute(sql`
        SELECT
          place_name,
          COUNT(*) AS cnt,
          ARRAY_AGG(id ORDER BY created_at DESC) AS ids
        FROM fonto.assets
        WHERE workspace_id IN (${wsList})
          AND place_name IS NOT NULL
          AND lifecycle_state = 'active'
        GROUP BY place_name
        HAVING COUNT(*) >= ${MIN_ASSETS}
        ORDER BY cnt DESC
        LIMIT 50
      `)) as unknown as { place_name: string; cnt: string | number; ids: string[] }[];

      return rows.map((r) => ({
        placeName: r.place_name,
        count: Number(r.cnt),
        previewIds: (r.ids ?? []).slice(0, 4),
      }));
    },
    ["places-list", sortedIds.join(",")],
    {
      tags: sortedIds.flatMap((id) => [`ws:${id}:places`, `ws:${id}:assets`]),
      revalidate: 300,
    },
  )();
};

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ places: [] });
  const wsIds = workspaces.map((w) => w.id);

  const places = await loadPlaces(wsIds);
  return NextResponse.json({ places });
}
