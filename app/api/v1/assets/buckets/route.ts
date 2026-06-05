// SPDX-License-Identifier: AGPL-3.0-only
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
import { and, eq, gte, isNull, like, or, sql, SQL } from "drizzle-orm";

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
  ];

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

  // Bucket strictly by capture date. Assets with no real capture date (NULL
  // captured_at — i.e. the big Drive import's date-less placeholders) collapse
  // into a single "undated" bucket instead of being coalesced onto created_at,
  // which would dump the whole import into the current month. The client renders
  // "undated" as a segregated "Undated" section pinned to the bottom.
  const monthExpr = sql<string>`COALESCE(to_char(${schema.assets.capturedAt}, 'YYYY-MM'), 'undated')`;

  const rows = await db
    .select({ month: monthExpr, count: sql<number>`COUNT(*)::int` })
    .from(schema.assets)
    .where(and(...where))
    .groupBy(monthExpr)
    // Dated months newest-first; the undated bucket always sorts last.
    .orderBy(
      sql`CASE WHEN ${monthExpr} = 'undated' THEN 1 ELSE 0 END`,
      sql`${monthExpr} DESC`
    );

  return NextResponse.json({ buckets: rows });
}
