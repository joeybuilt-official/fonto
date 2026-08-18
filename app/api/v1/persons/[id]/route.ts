// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — /api/v1/persons/:id
//   GET    — person detail + first N faces (default 24).
//   PATCH  — { name?, hidden?, cover_face_id? }
//   DELETE — detach faces (person_id -> NULL) then drop the person row.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { propagateNamedPerson } from "@/lib/faces/propagate";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { parsePartialDate, toColumns } from "@/lib/temporal/precision";
import { db, schema } from "@/lib/db";
import { invalidateByDependency } from "@/lib/reaudit/invalidate";

const DEFAULT_FACES_LIMIT = 24;
const MAX_FACES_LIMIT = 200;

async function loadPersonInWorkspaces(id: string, workspaceIds: string[]) {
  const [row] = await db
    .select()
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.id, id),
        inArray(schema.persons.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  return row ?? null;
}

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

  const person = await loadPersonInWorkspaces(id, workspaceIds);
  if (!person) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Viewer is enough to read.
  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    person.workspaceId,
    "viewer"
  );
  if (!gate.ok) return gate.response;

  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Math.min(
    MAX_FACES_LIMIT,
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_FACES_LIMIT
  );

  const faces = await db
    .select({
      id: schema.faceInstances.id,
      assetId: schema.faceInstances.assetId,
      bbox: schema.faceInstances.bbox,
      confidence: schema.faceInstances.confidence,
      hidden: schema.faceInstances.hidden,
      createdAt: schema.faceInstances.createdAt,
      faceCropKey: schema.faceInstances.faceCropKey,
    })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.personId, person.id),
        eq(schema.faceInstances.hidden, false)
      )
    )
    .limit(limit);

  // Load group memberships for this person.
  const memberRows = await db
    .select({ groupId: schema.personGroupMembers.groupId })
    .from(schema.personGroupMembers)
    .where(eq(schema.personGroupMembers.personId, person.id));
  const groupIds = memberRows.map((m) => m.groupId);

  return NextResponse.json({
    person: {
      id: person.id,
      workspaceId: person.workspaceId,
      name: person.name,
      coverFaceId: person.coverFaceId,
      instanceCount: person.instanceCount,
      hidden: person.hidden,
      birthDate: person.birthDate,
      birthPrecision: person.birthPrecision,
      deathDate: person.deathDate,
      deathPrecision: person.deathPrecision,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
      groupIds,
    },
    faces: faces.map((f) => ({
      ...f,
      createdAt: f.createdAt.toISOString(),
      // Phase 1 (faces/UX) — dedicated square crop URL (NULL until generated).
      faceCropUrl: f.faceCropKey
        ? `/api/v1/assets/${f.assetId}/url?variant=face&faceId=${f.id}`
        : null,
    })),
  });
}

interface PatchBody {
  name?: unknown;
  hidden?: unknown;
  cover_face_id?: unknown;
  coverFaceId?: unknown;
  // Intelligence Core (ADR-0002) — partial-date strings (YYYY | YYYY-MM |
  // YYYY-MM-DD) or null to clear. Birth/death anchor the date-inference engine.
  birth?: unknown;
  death?: unknown;
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

  const person = await loadPersonInWorkspaces(id, workspaceIds);
  if (!person) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    person.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as PatchBody;

  const patch: {
    name?: string | null;
    hidden?: boolean;
    coverFaceId?: string | null;
    birthDate?: string | null;
    birthPrecision?: string | null;
    deathDate?: string | null;
    deathPrecision?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  // birth / death partial dates.
  for (const [key, dateCol, precCol] of [
    ["birth", "birthDate", "birthPrecision"],
    ["death", "deathDate", "deathPrecision"],
  ] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null || v === "") {
      patch[dateCol] = null;
      patch[precCol] = null;
    } else if (typeof v === "string") {
      const parsed = parsePartialDate(v);
      if (!parsed) {
        return NextResponse.json(
          { error: `${key} must be YYYY | YYYY-MM | YYYY-MM-DD or null` },
          { status: 400 }
        );
      }
      const cols = toColumns(parsed);
      patch[dateCol] = cols.date;
      patch[precCol] = cols.precision;
    } else {
      return NextResponse.json({ error: `${key} must be a string or null` }, { status: 400 });
    }
  }

  if ("name" in body) {
    if (body.name === null) patch.name = null;
    else if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      patch.name = trimmed.length === 0 ? null : trimmed.slice(0, 200);
    } else {
      return NextResponse.json({ error: "name must be string or null" }, { status: 400 });
    }
  }
  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") {
      return NextResponse.json({ error: "hidden must be boolean" }, { status: 400 });
    }
    patch.hidden = body.hidden;
  }
  const coverRaw = body.cover_face_id ?? body.coverFaceId;
  if (coverRaw !== undefined) {
    if (coverRaw === null) {
      patch.coverFaceId = null;
    } else if (typeof coverRaw === "string") {
      // Validate the face belongs to this person (and so to this workspace).
      const [face] = await db
        .select({ id: schema.faceInstances.id })
        .from(schema.faceInstances)
        .where(
          and(
            eq(schema.faceInstances.id, coverRaw),
            eq(schema.faceInstances.workspaceId, person.workspaceId)
          )
        )
        .limit(1);
      if (!face) {
        return NextResponse.json(
          { error: "cover_face_id must reference a face in this workspace" },
          { status: 400 }
        );
      }
      patch.coverFaceId = coverRaw;
    } else {
      return NextResponse.json(
        { error: "cover_face_id must be uuid or null" },
        { status: 400 }
      );
    }
  }

  const [updated] = await db
    .update(schema.persons)
    .set(patch)
    .where(eq(schema.persons.id, person.id))
    .returning();

  // Ignoring a junk cluster must keep it gone: cascade hidden to the
  // person's faces so re-clustering (which excludes hidden faces) can't
  // resurrect them as a fresh visible cluster. Un-ignore restores them.
  if (patch.hidden !== undefined) {
    await db
      .update(schema.faceInstances)
      .set({ hidden: patch.hidden })
      .where(eq(schema.faceInstances.personId, person.id));
  }

  // When a name is freshly set, propagate to visually similar untagged faces.
  if (patch.name && !person.name) {
    propagateNamedPerson(updated.id, updated.workspaceId).catch(() => {});
  }

  // Phase 7 — birth/death are the strongest identity_bound date anchors. A
  // change re-audits every inference that leaned on this person.
  if ("birth" in body || "death" in body) {
    void invalidateByDependency({ workspaceId: person.workspaceId, personIds: [person.id] });
  }

  return NextResponse.json({
    person: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const person = await loadPersonInWorkspaces(id, workspaceIds);
  if (!person) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    person.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  // Detach faces first so a re-cluster can re-attach them to a fresh person.
  await db
    .update(schema.faceInstances)
    .set({ personId: null })
    .where(eq(schema.faceInstances.personId, person.id));
  await db.delete(schema.persons).where(eq(schema.persons.id, person.id));

  // Touch persons.updated_at for any reciprocal denorms — currently a no-op
  // but kept to mirror the pattern from `/stacks` DELETE.
  await db.execute(sql`SELECT 1`);

  // Phase 7 — dependents lose this person's date anchor; re-audit them.
  void invalidateByDependency({ workspaceId: person.workspaceId, personIds: [person.id] });

  return NextResponse.json({ ok: true as const });
}
