// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — GET /api/v1/persons/:id/faces
//
// Paginated faces for a person, joined with the asset they came from so the
// People detail page can render bbox crops without N round-trips.
//
// Pagination: cursor-less offset (matches the simpler routes in this repo).
// `limit` defaults to 60, max 200; `offset` defaults to 0.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, desc } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
// Face crop + preview are immutable content-addressed derivatives → sign toward
// the SigV4 ceiling (7 days); the original fallback stays short-lived.
const CROP_TTL_DERIVATIVE_SEC = 7 * 24 * 60 * 60; // 604800
const CROP_TTL_ORIGINAL_SEC = 3600; // 1 hour

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [person] = await db
    .select()
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.id, id),
        inArray(schema.persons.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!person) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    person.workspaceId,
    "viewer"
  );
  if (!gate.ok) return gate.response;

  const url = request.nextUrl;
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "");
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT
  );
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const faces = await db
    .select({
      id: schema.faceInstances.id,
      assetId: schema.faceInstances.assetId,
      bbox: schema.faceInstances.bbox,
      confidence: schema.faceInstances.confidence,
      hidden: schema.faceInstances.hidden,
      createdAt: schema.faceInstances.createdAt,
      faceCropKey: schema.faceInstances.faceCropKey,
      assetWorkspaceId: schema.assets.workspaceId,
      assetFilename: schema.assets.filename,
      assetMimeType: schema.assets.mimeType,
      thumbnailKey: schema.assets.thumbnailKey,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.faceInstances)
    .innerJoin(
      schema.assets,
      eq(schema.faceInstances.assetId, schema.assets.id)
    )
    .where(eq(schema.faceInstances.personId, person.id))
    .orderBy(desc(schema.faceInstances.createdAt))
    .limit(limit)
    .offset(offset);

  // Resolve + presign each face crop INLINE so the detail grid renders without
  // a per-card GET /assets/{id}/url round-trip. Prefer the dedicated square
  // crop; fall back to the asset preview, then the original, so a crop always
  // resolves even mid-backfill.
  const faceCropUrls = await Promise.all(
    faces.map(async (f) => {
      let key: string;
      let expiresIn: number;
      if (f.faceCropKey) {
        key = f.faceCropKey;
        expiresIn = CROP_TTL_DERIVATIVE_SEC;
      } else if (f.previewKey) {
        key = f.previewKey;
        expiresIn = CROP_TTL_DERIVATIVE_SEC;
      } else {
        key = assetStorageKey(f.assetWorkspaceId, f.assetId, f.assetFilename);
        expiresIn = CROP_TTL_ORIGINAL_SEC;
      }
      try {
        return await storage().presignGet(key, { expiresIn });
      } catch {
        // A sign failure must not sink the whole grid — the card falls back to
        // the client's bbox/CSS crop off `bbox` + the asset preview.
        return null;
      }
    })
  );

  return NextResponse.json({
    faces: faces.map((f, i) => ({
      id: f.id,
      assetId: f.assetId,
      bbox: f.bbox,
      confidence: f.confidence,
      hidden: f.hidden,
      createdAt: f.createdAt.toISOString(),
      // Phase 1 (faces/UX) — dedicated square crop (NULL until generated). The
      // detail grid renders this sharp crop instead of CSS-zooming `preview`.
      faceCropKey: f.faceCropKey,
      // RELATIVE resolve URL — mobile clients call resolveSignedUrl() on this,
      // so it MUST stay relative for backward-compat with installed apps.
      faceCropUrl: f.faceCropKey
        ? `/api/v1/assets/${f.assetId}/url?variant=face&faceId=${f.id}`
        : null,
      // Absolute pre-signed R2 URL — the web detail grid uses this directly.
      faceCropSignedUrl: faceCropUrls[i],
      asset: {
        id: f.assetId,
        filename: f.assetFilename,
        mimeType: f.assetMimeType,
        thumbnailKey: f.thumbnailKey,
        previewKey: f.previewKey,
        // The lightbox prefers `/api/v1/assets/:id/url?variant=preview`.
        previewUrl: `/api/v1/assets/${f.assetId}/url?variant=preview`,
      },
    })),
    limit,
    offset,
  });
}
