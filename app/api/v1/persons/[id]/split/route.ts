// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — POST /api/v1/persons/:id/split
//
// Body: { face_ids: string[] }
//
// Move the listed faces into a brand-new anonymous person row (the user
// then renames it in the UI). The source person keeps every other face.
//
// `face_ids` must all currently belong to the source person and live in
// the same workspace; mismatches are rejected with 400.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { cacheInvalidate } from "@/lib/cache/valkey";
import { revalidateTag } from "next/cache";

interface SplitBody {
  face_ids?: unknown;
  faceIds?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as SplitBody;
  const raw = body.face_ids ?? body.faceIds;
  const faceIds = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : [];
  if (faceIds.length === 0) {
    return NextResponse.json(
      { error: "face_ids (non-empty string[]) required" },
      { status: 400 }
    );
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [source] = await db
    .select()
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.id, id),
        inArray(schema.persons.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    source.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  // Validate every requested face belongs to the source.
  const faces = await db
    .select({
      id: schema.faceInstances.id,
      personId: schema.faceInstances.personId,
      workspaceId: schema.faceInstances.workspaceId,
    })
    .from(schema.faceInstances)
    .where(inArray(schema.faceInstances.id, faceIds));

  if (faces.length !== faceIds.length) {
    return NextResponse.json(
      { error: "one or more face_ids do not exist" },
      { status: 400 }
    );
  }
  for (const f of faces) {
    if (f.workspaceId !== source.workspaceId || f.personId !== source.id) {
      return NextResponse.json(
        { error: "all face_ids must belong to this person" },
        { status: 400 }
      );
    }
  }

  const [newPerson] = await db
    .insert(schema.persons)
    .values({
      workspaceId: source.workspaceId,
      name: null,
      coverFaceId: faceIds[0],
      instanceCount: 0,
    })
    .returning();

  await db
    .update(schema.faceInstances)
    .set({ personId: newPerson.id })
    .where(inArray(schema.faceInstances.id, faceIds));

  // Recompute both persons' instance_count in one SQL pass.
  await db.execute(sql`
    UPDATE fonto.persons
    SET instance_count = COALESCE(c.cnt, 0),
        updated_at = now()
    FROM (
      SELECT person_id, COUNT(*)::int AS cnt
      FROM fonto.face_instances
      WHERE person_id IN (${source.id}, ${newPerson.id})
      GROUP BY person_id
    ) c
    WHERE fonto.persons.id = c.person_id
  `);

  // The persons list is Valkey-cached for 5 minutes (see GET /api/v1/persons),
  // so without this the split-out person never appears in the People grid and
  // the source keeps its old face count — the split reads as "nothing
  // happened". AWAITED for the same reason as the merge route: the client
  // refetches the list immediately after this response, so the eviction has to
  // have happened before we reply. The helper fails open with a 250ms command
  // timeout, so a Valkey blip cannot stall the split.
  revalidateTag(`ws:${source.workspaceId}:persons`, "max");
  await cacheInvalidate(`ws:${source.workspaceId}:persons`);

  const [sourceAfter] = await db
    .select()
    .from(schema.persons)
    .where(eq(schema.persons.id, source.id))
    .limit(1);
  const [newAfter] = await db
    .select()
    .from(schema.persons)
    .where(eq(schema.persons.id, newPerson.id))
    .limit(1);

  return NextResponse.json(
    {
      ok: true as const,
      source: sourceAfter
        ? {
            ...sourceAfter,
            createdAt: sourceAfter.createdAt.toISOString(),
            updatedAt: sourceAfter.updatedAt.toISOString(),
          }
        : null,
      person: newAfter
        ? {
            ...newAfter,
            createdAt: newAfter.createdAt.toISOString(),
            updatedAt: newAfter.updatedAt.toISOString(),
          }
        : null,
    },
    { status: 201 }
  );
}
