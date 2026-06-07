// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — PATCH /api/v1/faces/:id
//
// Body: { hidden?: boolean, person_id?: string | null }
//
// Powers the lightbox "hide this face / reassign to another person" UI.
// When `person_id` changes, both the old and the new person's
// instance_count are recomputed in a single SQL pass.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { propagateNamedPerson } from "@/lib/faces/propagate";

interface PatchBody {
  hidden?: unknown;
  person_id?: unknown;
  personId?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [face] = await db
    .select()
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.id, id),
        inArray(schema.faceInstances.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!face) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    face.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as PatchBody;

  const patch: { hidden?: boolean; personId?: string | null } = {};
  let touchedPersonIds: string[] = [];
  // When a face is manually assigned to a NAMED person, we proactively
  // propagate that match to other visually-similar unassigned faces
  // (D2 hybrid: auto-assign tight matches, count the borderline band for
  // review). Null name => unnamed cluster; skip to avoid over-sweeping.
  let targetPersonName: string | null = null;

  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") {
      return NextResponse.json({ error: "hidden must be boolean" }, { status: 400 });
    }
    patch.hidden = body.hidden;
  }

  const personRaw = body.person_id ?? body.personId;
  if (personRaw !== undefined) {
    if (personRaw === null) {
      patch.personId = null;
    } else if (typeof personRaw === "string") {
      // Validate the target person is in the same workspace.
      const [target] = await db
        .select({ id: schema.persons.id, name: schema.persons.name })
        .from(schema.persons)
        .where(
          and(
            eq(schema.persons.id, personRaw),
            eq(schema.persons.workspaceId, face.workspaceId)
          )
        )
        .limit(1);
      if (!target) {
        return NextResponse.json(
          { error: "person_id must reference a person in this workspace" },
          { status: 400 }
        );
      }
      patch.personId = personRaw;
      targetPersonName = target.name;
    } else {
      return NextResponse.json(
        { error: "person_id must be uuid or null" },
        { status: 400 }
      );
    }
    if (face.personId) touchedPersonIds.push(face.personId);
    if (typeof patch.personId === "string") touchedPersonIds.push(patch.personId);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "no editable fields provided" },
      { status: 400 }
    );
  }

  const [updated] = await db
    .update(schema.faceInstances)
    .set(patch)
    .where(eq(schema.faceInstances.id, face.id))
    .returning();

  // Recompute instance_count for any affected persons. Dedup ids first.
  touchedPersonIds = Array.from(new Set(touchedPersonIds));
  if (touchedPersonIds.length > 0) {
    // Two-step (count then update) avoids hand-built IN-lists in raw SQL —
    // Drizzle parametrises both passes, so PG plans them well at this size.
    const counts = await db
      .select({
        personId: schema.faceInstances.personId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(schema.faceInstances)
      .where(inArray(schema.faceInstances.personId, touchedPersonIds))
      .groupBy(schema.faceInstances.personId);
    const seen = new Set<string>();
    for (const row of counts) {
      if (!row.personId) continue;
      seen.add(row.personId);
      await db
        .update(schema.persons)
        .set({ instanceCount: row.cnt, updatedAt: new Date() })
        .where(eq(schema.persons.id, row.personId));
    }
    // Persons that lost all their faces get zeroed.
    for (const pid of touchedPersonIds) {
      if (seen.has(pid)) continue;
      await db
        .update(schema.persons)
        .set({ instanceCount: 0, updatedAt: new Date() })
        .where(eq(schema.persons.id, pid));
    }
  }

  // Proactive auto-tag: only when the face was just assigned to a NAMED
  // person. propagate is idempotent + protects other named persons' faces.
  let propagated: { assigned: number; suggested: number } | null = null;
  if (typeof patch.personId === "string" && targetPersonName) {
    propagated = await propagateNamedPerson(patch.personId, face.workspaceId);
  }

  return NextResponse.json({
    face: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
    },
    propagated,
  });
}
