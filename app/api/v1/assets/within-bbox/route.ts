// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.2 — map viewport query. Returns assets in a lat/lon bounding box,
// scoped to the caller's primary workspace. Drives the map page's marker /
// supercluster rendering on every pan / zoom debounce.
//
// Query:
//   GET /api/v1/assets/within-bbox
//     ?minLat=51.4 &maxLat=51.6
//     &minLon=-0.2 &maxLon=0.0
//     &limit=2000          (optional; default 2000, cap 5000)
//
// Response:
//   { assets: [{ id, latitude, longitude, thumbnailUrl, capturedAt, placeName }, ...] }
//
// Index: `assets_lat_lon_idx` (Phase 0.3 — btree on (latitude, longitude)).
// The (workspace_id, lifecycle_state) predicate runs first via
// `assets_workspace_id_idx` + the partial lifecycle indexes; Postgres uses
// the lat/lon range as the secondary filter. For workspaces with millions of
// rows we'd want an index that leads with workspace_id (or a GIST over a
// point column); the current shape is fine for the V1.
//
// Auth: viewer or higher. Same session/PAT flow as the rest of /api/v1.

import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { parseScopeParam, scopeCond } from "@/lib/scope";

// Hard cap on rows returned in one response. Tuned with two competing
// pressures in mind:
//   - JSON payload size: 5k rows × ~200 bytes each ≈ 1 MB on the wire.
//   - Clustering perf: supercluster on the client handles 50k points fine,
//     but the client-side render and the round-trip cost don't.
// If the user pans super-far-out, the front end debounces and falls back to
// "too many — zoom in" rather than spamming.
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 2000;

function parseFloatOr(raw: string | null, fallback: number | null): number | null {
  if (raw == null || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntOr(raw: string | null, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface WithinBboxAsset {
  id: string;
  latitude: number;
  longitude: number;
  thumbnailUrl: string | null;
  capturedAt: string | null;
  placeName: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ assets: [] });
  }
  const workspaceId = workspaces[0].id;

  const sp = request.nextUrl.searchParams;
  const minLat = parseFloatOr(sp.get("minLat"), null);
  const maxLat = parseFloatOr(sp.get("maxLat"), null);
  const minLon = parseFloatOr(sp.get("minLon"), null);
  const maxLon = parseFloatOr(sp.get("maxLon"), null);
  if (minLat == null || maxLat == null || minLon == null || maxLon == null) {
    return NextResponse.json(
      { error: "minLat, maxLat, minLon, maxLon are required floats." },
      { status: 400 }
    );
  }
  if (minLat > maxLat || minLon > maxLon) {
    return NextResponse.json(
      { error: "minLat must be ≤ maxLat and minLon ≤ maxLon." },
      { status: 400 }
    );
  }
  if (
    minLat < -90 || maxLat > 90 ||
    minLon < -180 || maxLon > 180
  ) {
    return NextResponse.json(
      { error: "Coordinates out of WGS-84 range." },
      { status: 400 }
    );
  }

  const limit = Math.min(parseIntOr(sp.get("limit"), DEFAULT_LIMIT), MAX_LIMIT);

  const rows = await db
    .select({
      id: schema.assets.id,
      latitude: schema.assets.latitude,
      longitude: schema.assets.longitude,
      capturedAt: schema.assets.capturedAt,
      placeName: schema.assets.placeName,
      thumbnailKey: schema.assets.thumbnailKey,
      filename: schema.assets.filename,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        // ADR 0008 — scope default
        scopeCond(parseScopeParam(sp)),
        isNotNull(schema.assets.latitude),
        isNotNull(schema.assets.longitude),
        gte(schema.assets.latitude, minLat),
        lte(schema.assets.latitude, maxLat),
        gte(schema.assets.longitude, minLon),
        lte(schema.assets.longitude, maxLon)
      )
    )
    // capturedAt desc keeps the "show the latest N photos in this region"
    // semantics when the bbox holds more than `limit` rows — same shape the
    // timeline uses.
    .orderBy(sql`${schema.assets.capturedAt} desc nulls last`)
    .limit(limit);

  const assets: WithinBboxAsset[] = rows
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => ({
      id: r.id,
      latitude: r.latitude as number,
      longitude: r.longitude as number,
      capturedAt: r.capturedAt ? r.capturedAt.toISOString() : null,
      placeName: r.placeName ?? null,
      // Same scheme as `assetDerivativeKey` so the client can build a URL
      // via the existing `/api/v1/assets/:id/url` helper. We surface the
      // signed-URL endpoint path directly here so the marker icon renderer
      // doesn't have to know about R2 layout.
      thumbnailUrl: r.thumbnailKey
        ? `/api/v1/assets/${r.id}/url?variant=thumbnail`
        : null,
    }));

  return NextResponse.json({ assets });
}
