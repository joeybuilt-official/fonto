// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/assets/places — Explore "Places" directory.
//
// Groups the caller's primary-workspace assets by reverse-geocoded
// `place_name` (populated by the worker from EXIF GPS) and returns one row
// per place: { name, count, coverAssetId }, ordered by count desc. The cover
// asset is the most recent in that place so the grid can render a thumbnail
// via /api/v1/assets/:id/url. Assets without a place (no GPS) are excluded.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

interface PlaceOut {
  name: string;
  count: number;
  coverAssetId: string | null;
  // Mean GPS of the place's assets so the grid can render a map thumbnail
  // (a random photo cover told the user nothing about the location).
  lat: number | null;
  lng: number | null;
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ places: [] });
  const workspaceId = workspaces[0].id;

  const rows = await db
    .select({
      name: schema.assets.placeName,
      count: sql<number>`count(*)::int`,
      coverAssetId: sql<
        string | null
      >`(array_agg(${schema.assets.id} ORDER BY ${schema.assets.createdAt} DESC))[1]`,
      lat: sql<number | null>`avg(${schema.assets.latitude})`,
      lng: sql<number | null>`avg(${schema.assets.longitude})`,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        // ADR 0008 — scope default (no browse param on this route)
        eq(schema.assets.scope, "PERSONAL"),
        isNotNull(schema.assets.placeName),
        ne(schema.assets.placeName, "")
      )
    )
    .groupBy(schema.assets.placeName)
    .orderBy(sql`count(*) DESC`);

  const places: PlaceOut[] = rows.map((r) => ({
    name: r.name ?? "",
    count: r.count,
    coverAssetId: r.coverAssetId ?? null,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
  }));

  return NextResponse.json({ places });
}
