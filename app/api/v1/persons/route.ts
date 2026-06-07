// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — GET /api/v1/persons.
//
// Lists the caller's primary workspace's persons (id, name, cover_face_id,
// instance_count, sample face thumbnail URL), ordered by instance_count desc.
// Hidden persons are excluded by default; pass `?hidden=true` to include.
//
// The sample thumbnail URL points at the asset the cover face belongs to —
// crop is rendered client-side via the bbox on the face row (the People grid
// uses a CSS object-position / background-position trick). For asset URL
// resolution we reuse the existing `/api/v1/assets/:id/url` helper.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, sql, exists } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { propagateNamedPerson } from "@/lib/faces/propagate";
import { db, schema } from "@/lib/db";

interface PersonOut {
  id: string;
  workspaceId: string;
  name: string | null;
  coverFaceId: string | null;
  instanceCount: number;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  coverAssetId: string | null;
  coverBbox: { x: number; y: number; w: number; h: number } | null;
  coverFaceCropKey: string | null;
  coverFaceCropUrl: string | null;
  groupIds: string[];
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ persons: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const includeHidden = request.nextUrl.searchParams.get("hidden") === "true";
  const filterGroupId = request.nextUrl.searchParams.get("group_id");

  // Default grid excludes hidden persons AND empty clusters (instance_count
  // = 0). A re-cluster zeroes-out persons whose faces were all detached
  // (e.g. the junk-screenshot prune) but keeps the row to preserve any
  // name/hidden edits — those empty rows must never render as ghost cards.
  const baseWhere = includeHidden
    ? inArray(schema.persons.workspaceId, workspaceIds)
    : and(
        inArray(schema.persons.workspaceId, workspaceIds),
        eq(schema.persons.hidden, false),
        gt(schema.persons.instanceCount, 0)
      );

  const where = filterGroupId
    ? and(
        baseWhere,
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.personGroupMembers)
            .where(
              and(
                eq(schema.personGroupMembers.personId, schema.persons.id),
                eq(schema.personGroupMembers.groupId, filterGroupId)
              )
            )
        )
      )
    : baseWhere;

  const rows = await db
    .select()
    .from(schema.persons)
    .where(where)
    .orderBy(
      sql`(${schema.persons.name} IS NOT NULL) DESC`,
      desc(schema.persons.instanceCount)
    );

  // Resolve cover face -> asset + bbox in a single batch lookup.
  const coverFaceIds = rows
    .map((r) => r.coverFaceId)
    .filter((id): id is string => typeof id === "string");

  const facesById = new Map<
    string,
    { assetId: string; bbox: unknown; faceCropKey: string | null }
  >();
  if (coverFaceIds.length > 0) {
    const faceRows = await db
      .select({
        id: schema.faceInstances.id,
        assetId: schema.faceInstances.assetId,
        bbox: schema.faceInstances.bbox,
        faceCropKey: schema.faceInstances.faceCropKey,
      })
      .from(schema.faceInstances)
      .where(inArray(schema.faceInstances.id, coverFaceIds));
    for (const f of faceRows) {
      facesById.set(f.id, {
        assetId: f.assetId,
        bbox: f.bbox,
        faceCropKey: f.faceCropKey,
      });
    }
  }

  // Batch-load group memberships for all returned persons.
  const personIds = rows.map((r) => r.id);
  const groupsByPerson = new Map<string, string[]>();
  if (personIds.length > 0) {
    const memberRows = await db
      .select({
        personId: schema.personGroupMembers.personId,
        groupId: schema.personGroupMembers.groupId,
      })
      .from(schema.personGroupMembers)
      .where(inArray(schema.personGroupMembers.personId, personIds));
    for (const m of memberRows) {
      const list = groupsByPerson.get(m.personId) ?? [];
      list.push(m.groupId);
      groupsByPerson.set(m.personId, list);
    }
  }

  const persons: PersonOut[] = rows.map((p) => {
    const cover = p.coverFaceId ? facesById.get(p.coverFaceId) : undefined;
    const bb = cover?.bbox as
      | { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
      | undefined;
    const bbox =
      bb &&
      typeof bb.x === "number" &&
      typeof bb.y === "number" &&
      typeof bb.w === "number" &&
      typeof bb.h === "number"
        ? { x: bb.x, y: bb.y, w: bb.w, h: bb.h }
        : null;
    return {
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      coverFaceId: p.coverFaceId,
      instanceCount: p.instanceCount,
      hidden: p.hidden,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      coverAssetId: cover?.assetId ?? null,
      coverBbox: bbox,
      coverFaceCropKey: cover?.faceCropKey ?? null,
      coverFaceCropUrl:
        cover && cover.faceCropKey && p.coverFaceId
          ? `/api/v1/assets/${cover.assetId}/url?variant=face&faceId=${p.coverFaceId}`
          : null,
      groupIds: groupsByPerson.get(p.id) ?? [],
    };
  });

  return NextResponse.json({ persons });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    workspaceId?: unknown;
  };

  const workspaceId =
    typeof body.workspaceId === "string" &&
    workspaces.some((w) => w.id === body.workspaceId)
      ? (body.workspaceId as string)
      : workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : null;

  const [person] = await db
    .insert(schema.persons)
    .values({ workspaceId, name, instanceCount: 0 })
    .returning();

  // Phase 1 (faces/UX), D2 — naming a NEW person is the primary "name a face"
  // path on mobile; trigger the hybrid match pass so tight matches auto-assign
  // and the borderline band is surfaced for review. Fire-and-forget: a slow /
  // failed pgvector sweep must not block the create response (mirrors PATCH).
  if (name) {
    propagateNamedPerson(person.id, person.workspaceId).catch(() => {});
  }

  return NextResponse.json({
    person: {
      ...person,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
    },
  }, { status: 201 });
}
