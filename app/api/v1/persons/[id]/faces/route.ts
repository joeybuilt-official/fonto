// SPDX-License-Identifier: AGPL-3.0-only
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

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

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

  return NextResponse.json({
    faces: faces.map((f) => ({
      id: f.id,
      assetId: f.assetId,
      bbox: f.bbox,
      confidence: f.confidence,
      hidden: f.hidden,
      createdAt: f.createdAt.toISOString(),
      // Phase 1 (faces/UX) — dedicated square crop (NULL until generated). The
      // detail grid renders this sharp crop instead of CSS-zooming `preview`.
      faceCropKey: f.faceCropKey,
      faceCropUrl: f.faceCropKey
        ? `/api/v1/assets/${f.assetId}/url?variant=face&faceId=${f.id}`
        : null,
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
