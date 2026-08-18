// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/faces/ignored
//
// The "Ignored" review surface (faces/UX). Returns the three things a user
// can ignore so they can undo them:
//   - persons: hidden clusters (un-ignore via PATCH /persons/:id { hidden:false })
//   - photos:  assets with faces_ignored (PATCH /assets/:id/faces-ignored)
//   - faces:   individually hidden faces NOT already covered by a hidden
//              person or an ignored photo (PATCH /faces/:id { hidden:false })
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(_request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ persons: [], photos: [], faces: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  // Cover crop URL needs the cover face's asset id, so join the cover face.
  const persons = (await db.execute(sql`
    SELECT p.id, p.name, p.instance_count, cf.asset_id AS cover_asset_id,
           cf.id AS cover_face_id, cf.face_crop_key AS cover_crop_key
    FROM fonto.persons p
    LEFT JOIN fonto.face_instances cf ON cf.id = p.cover_face_id
    WHERE p.workspace_id IN (${sql.join(workspaceIds, sql`, `)})
      AND p.hidden = true
  `)) as unknown as {
    id: string;
    name: string | null;
    instance_count: number;
    cover_asset_id: string | null;
    cover_face_id: string | null;
    cover_crop_key: string | null;
  }[];

  const photos = await db
    .select({
      id: schema.assets.id,
      filename: schema.assets.filename,
    })
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.workspaceId, workspaceIds),
        eq(schema.assets.facesIgnored, true)
      )
    )
    .limit(500);

  // Individually-ignored faces: hidden, but their person isn't hidden and
  // their photo isn't ignored (those are surfaced above, not here).
  const faces = (await db.execute(sql`
    SELECT fi.id, fi.asset_id, fi.face_crop_key
    FROM fonto.face_instances fi
    LEFT JOIN fonto.persons p ON p.id = fi.person_id
    JOIN fonto.assets a ON a.id = fi.asset_id
    WHERE fi.workspace_id IN (${sql.join(workspaceIds, sql`, `)})
      AND fi.hidden = true
      AND a.faces_ignored = false
      AND (p.id IS NULL OR p.hidden = false)
    LIMIT 500
  `)) as unknown as { id: string; asset_id: string; face_crop_key: string | null }[];

  return NextResponse.json({
    persons: persons.map((p) => ({
      id: p.id,
      name: p.name,
      instanceCount: p.instance_count,
      coverFaceCropUrl:
        p.cover_crop_key && p.cover_asset_id && p.cover_face_id
          ? `/api/v1/assets/${p.cover_asset_id}/url?variant=face&faceId=${p.cover_face_id}`
          : null,
    })),
    photos,
    faces: faces.map((f) => ({
      id: f.id,
      assetId: f.asset_id,
      faceCropUrl: f.face_crop_key
        ? `/api/v1/assets/${f.asset_id}/url?variant=face&faceId=${f.id}`
        : null,
    })),
  });
}
