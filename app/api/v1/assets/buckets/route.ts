// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Per-month asset counts for the timeline scrubber. Powers the fast-scroll
// date bubble + proportional scrubber: the client maps a scroll position to a
// month using these counts, and sizes each month's slice by its count.
//
//   GET /api/v1/assets/buckets[?type=image|video|doc&favorite=1&lifecycle=active]
//     → { buckets: [{ month: "YYYY-MM", count: <int> }, ...] }  (newest first)
//
// Buckets are by COALESCE(captured_at, created_at) — i.e. when the photo was
// taken — matching the timeline list's `sort=captured` ordering, so the
// scrubber and the grid stay in lockstep. Filters mirror the list route's
// server-side chip filters (type, favorite, lifecycle).
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, eq, exists, gte, isNull, inArray, like, or, sql, SQL } from "drizzle-orm";
import { isKind } from "@/lib/classify/kind";
import { parseScopeParam, scopeCond } from "@/lib/scope";
import { getCacheLayer } from "@/lib/cache/valkey";

interface Bucket {
  month: string;
  count: number;
}

// The scrubber counts aggregate every active asset in the workspace on each
// load (two ~1s passes at 150k+ assets). They only change on upload / lifecycle
// mutations, which already fire `cacheInvalidate(ws:<id>:assets)` — so cache
// under that same tag with a short TTL to also cover direct worker writes
// (kind assignment during processing bypasses the API invalidation path).
const BUCKETS_TTL_SEC = 60;

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ buckets: [] });
  const workspaceId = workspaces[0].id;

  const { searchParams } = request.nextUrl;
  const lifecycle = searchParams.get("lifecycle") ?? "active";
  const validLifecycles = ["active", "archivable", "archived", "trashed"];
  const lifecycleFilter = validLifecycles.includes(lifecycle) ? lifecycle : "active";

  const where: SQL[] = [
    eq(schema.assets.workspaceId, workspaceId),
    eq(schema.assets.lifecycleState, lifecycleFilter),
    // M12 / ADR 0014 — exclude absorbed Apple companions so scrubber bucket
    // counts match the grid.
    eq(schema.assets.motionCompanion, false),
  ];
  // ADR 0008 — scope default
  const __sc = scopeCond(parseScopeParam(searchParams));
  if (__sc) where.push(__sc);

  const favoriteParam = searchParams.get("favorite");
  if (favoriteParam === "1" || favoriteParam === "true") {
    where.push(eq(schema.assets.isFavorite, true));
  }

  const ratingMinRaw = searchParams.get("ratingMin");
  const ratingMinParsed = ratingMinRaw == null ? NaN : Number.parseInt(ratingMinRaw, 10);
  if (Number.isInteger(ratingMinParsed) && ratingMinParsed >= 1 && ratingMinParsed <= 5) {
    where.push(gte(schema.assets.rating, ratingMinParsed));
  }

  const typeFilter = searchParams.get("type");
  if (typeFilter === "image") {
    where.push(like(schema.assets.mimeType, "image/%"));
  } else if (typeFilter === "video") {
    where.push(like(schema.assets.mimeType, "video/%"));
  } else if (typeFilter === "doc") {
    where.push(
      or(
        like(schema.assets.mimeType, "text/%"),
        eq(schema.assets.mimeType, "application/pdf"),
        like(schema.assets.mimeType, "application/vnd.openxmlformats-officedocument.%"),
        eq(schema.assets.mimeType, "application/msword")
      )!
    );
  }

  // Phase 2 — mirror the list route's chip filters so the scrubber domain
  // tracks whatever the Library chip strip narrows to (mime prefix,
  // classification, folder). Applied in SQL here (pure aggregate, no keyset
  // concern) so the per-month counts stay exact under every chip combination.
  const mimeFilter = searchParams.get("mime");
  if (mimeFilter) where.push(like(schema.assets.mimeType, `${mimeFilter}%`));

  const subtypeFilter = searchParams.get("subtype");
  if (subtypeFilter) where.push(eq(schema.assets.classification, subtypeFilter));

  // Task 20 + Photos/Files split — KIND lens filter; keeps the scrubber domain
  // in lockstep with the list route's ?kind= lens. Accepts a single kind or a
  // comma-separated set (Photos "All" = "moment,video"). Backed by
  // assets_workspace_kind_idx.
  const kindFilter = searchParams.get("kind");
  if (kindFilter) {
    const kinds = kindFilter.split(",").map((k) => k.trim()).filter((k) => isKind(k));
    if (kinds.length === 1) where.push(eq(schema.assets.kind, kinds[0]));
    else if (kinds.length > 1) where.push(inArray(schema.assets.kind, kinds));
  }

  // Photos/Files split — Inbox count. `?unclassified=1` restricts to NULL-kind
  // assets so the Library can show an exact "N pending" badge.
  const unclassifiedParam = searchParams.get("unclassified");
  if (unclassifiedParam === "1" || unclassifiedParam === "true") {
    where.push(isNull(schema.assets.kind));
  }

  const directoryPathRaw = searchParams.get("directoryPath");
  const directoryPathPrefixRaw = searchParams.get("directoryPathPrefix");
  const directoryPath = directoryPathRaw == null ? null : directoryPathRaw.trim();
  const directoryPathPrefix =
    directoryPathPrefixRaw == null ? null : directoryPathPrefixRaw.trim();
  if (directoryPath != null) {
    if (directoryPath === "" || directoryPath === "/") {
      where.push(isNull(schema.assets.directoryPath));
    } else {
      where.push(eq(schema.assets.directoryPath, directoryPath));
    }
  } else if (directoryPathPrefix != null && directoryPathPrefix !== "") {
    const normalised = directoryPathPrefix.replace(/\/+$/, "");
    where.push(like(schema.assets.directoryPath, `${normalised}/%`));
  }

  const groupIdParam = searchParams.get("group_id");
  if (groupIdParam) {
    where.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.faceInstances)
          .innerJoin(
            schema.personGroupMembers,
            eq(schema.personGroupMembers.personId, schema.faceInstances.personId)
          )
          .where(
            and(
              eq(schema.faceInstances.assetId, schema.assets.id),
              eq(schema.personGroupMembers.groupId, groupIdParam)
            )
          )
      )
    );
  }

  // Phase 5.5 / Task 20 — collapse stacks the same way the list route does
  // (count standalone assets OR each stack's primary), so the scrubber's
  // per-month counts and height reservation match the collapsed grid the
  // timeline actually renders. The timeline never expands stacks, so this is
  // unconditional here. Correlated subquery is index-driven via
  // stacks_primary_asset_id_idx + assets_workspace_stack_idx.
  where.push(
    or(
      isNull(schema.assets.stackId),
      sql`${schema.assets.id} = (SELECT ${schema.stacks.primaryAssetId} FROM ${schema.stacks} WHERE ${schema.stacks.id} = ${schema.assets.stackId})`
    )!
  );

  // Bucket strictly by capture date. Assets with no real capture date (NULL
  // captured_at — i.e. the big Drive import's date-less placeholders) collapse
  // into a single "undated" bucket instead of being coalesced onto created_at,
  // which would dump the whole import into the current month. The client renders
  // "undated" as a segregated "Undated" section pinned to the bottom.
  const monthExpr = sql<string>`COALESCE(to_char(${schema.assets.capturedAt}, 'YYYY-MM'), 'undated')`;

  // Cache key = workspace + the full (sorted) filter param set. Same raw params
  // → same buckets, so sorting the query string gives a stable, collision-free
  // key across every chip/lens/scope combination.
  const keyParams = new URLSearchParams(searchParams);
  keyParams.sort();
  const cacheKey = `buckets:${workspaceId}:${keyParams.toString()}`;

  const cache = getCacheLayer<Bucket[]>();
  const buckets = await cache.getOrCompute(
    cacheKey,
    BUCKETS_TTL_SEC,
    async () =>
      db
        .select({ month: monthExpr, count: sql<number>`COUNT(*)::int` })
        .from(schema.assets)
        .where(and(...where))
        .groupBy(monthExpr)
        // Dated months newest-first; the undated bucket always sorts last.
        .orderBy(
          sql`CASE WHEN ${monthExpr} = 'undated' THEN 1 ELSE 0 END`,
          sql`${monthExpr} DESC`
        ),
    { cacheName: "buckets", workspaceId, tags: [`ws:${workspaceId}:assets`] }
  );

  return NextResponse.json({ buckets });
}
