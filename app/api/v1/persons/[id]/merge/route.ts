// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — POST /api/v1/persons/:id/merge
//
// Body: { into: personId }
//
// Move every face_instance attached to `:id` over to `into`, then delete
// the now-empty source person. Both persons must be in the caller's
// workspace; the target's `name` / `coverFaceId` are preserved.
//
// `instance_count` is recomputed for the target person from face_instances
// at the end of the merge so denorm drift is impossible.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { recomputeCoverFacesForWorkspace } from "@/lib/faces/cluster";
import { propagateNamedPerson } from "@/lib/faces/propagate";
import { db, schema } from "@/lib/db";

interface MergeBody {
  into?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as MergeBody;
  if (typeof body.into !== "string" || body.into.length === 0) {
    return NextResponse.json({ error: "into (personId) required" }, { status: 400 });
  }
  if (body.into === id) {
    return NextResponse.json({ error: "cannot merge a person into itself" }, { status: 400 });
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const rows = await db
    .select()
    .from(schema.persons)
    .where(
      and(
        inArray(schema.persons.id, [id, body.into]),
        inArray(schema.persons.workspaceId, workspaceIds)
      )
    );
  const source = rows.find((r) => r.id === id);
  const target = rows.find((r) => r.id === body.into);
  if (!source || !target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (source.workspaceId !== target.workspaceId) {
    return NextResponse.json(
      { error: "persons must share a workspace" },
      { status: 400 }
    );
  }

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    target.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  await db
    .update(schema.faceInstances)
    .set({ personId: target.id })
    .where(eq(schema.faceInstances.personId, source.id));

  await db.delete(schema.persons).where(eq(schema.persons.id, source.id));

  // Recompute target instance_count.
  await db.execute(sql`
    UPDATE fonto.persons
    SET instance_count = (
      SELECT COUNT(*)::int
      FROM fonto.face_instances
      WHERE person_id = ${target.id}
    ),
    updated_at = now()
    WHERE id = ${target.id}
  `);

  // Target absorbed source's faces — one of THOSE might be better than
  // whatever target's old cover was. Re-rank covers so the People grid
  // shows the new best face after the merge.
  await recomputeCoverFacesForWorkspace(target.workspaceId);

  // A merge is a strong manual signal that these faces are the target
  // person. Proactively propagate to similar unassigned faces (hybrid:
  // auto-assign tight, count borderline for review). Named target only.
  let propagated: { assigned: number; suggested: number } | null = null;
  if (target.name) {
    propagated = await propagateNamedPerson(target.id, target.workspaceId);
  }

  const [refreshed] = await db
    .select()
    .from(schema.persons)
    .where(eq(schema.persons.id, target.id))
    .limit(1);

  return NextResponse.json({
    ok: true as const,
    person: refreshed
      ? {
          ...refreshed,
          createdAt: refreshed.createdAt.toISOString(),
          updatedAt: refreshed.updatedAt.toISOString(),
        }
      : null,
    propagated,
  });
}
