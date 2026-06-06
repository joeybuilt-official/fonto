// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/assets/:id/faces
// Returns all non-hidden face instances for an asset, with person name if
// assigned. Used by the mobile face-tagging overlay.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      widthPx: schema.assets.widthPx,
      heightPx: schema.assets.heightPx,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!asset)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const faces = await db
    .select({
      id: schema.faceInstances.id,
      bbox: schema.faceInstances.bbox,
      confidence: schema.faceInstances.confidence,
      personId: schema.faceInstances.personId,
      hidden: schema.faceInstances.hidden,
      faceCropKey: schema.faceInstances.faceCropKey,
      personName: schema.persons.name,
    })
    .from(schema.faceInstances)
    .leftJoin(
      schema.persons,
      eq(schema.faceInstances.personId, schema.persons.id)
    )
    .where(
      and(
        eq(schema.faceInstances.assetId, id),
        eq(schema.faceInstances.workspaceId, asset.workspaceId),
        eq(schema.faceInstances.hidden, false)
      )
    );

  return NextResponse.json({
    assetWidthPx: asset.widthPx,
    assetHeightPx: asset.heightPx,
    faces: faces.map((f) => ({
      id: f.id,
      bbox: f.bbox,
      confidence: f.confidence,
      personId: f.personId,
      personName: f.personName,
      hidden: f.hidden,
      // Phase 1 (faces/UX) — dedicated square crop key (NULL until cropped).
      // The crop URL is served by /api/v1/assets/:id/url?variant=face&faceId=…
      // (signed, workspace-scoped). Clients prefer the crop over CSS-zooming.
      faceCropKey: f.faceCropKey,
      faceCropUrl: f.faceCropKey
        ? `/api/v1/assets/${id}/url?variant=face&faceId=${f.id}`
        : null,
    })),
  });
}
