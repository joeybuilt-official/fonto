// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// PATCH  /api/v1/person-groups/:id — rename / recolor (workspace-owned only)
// DELETE /api/v1/person-groups/:id — delete custom group (cascades memberships)
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";

async function loadGroup(id: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(schema.personGroups)
    .where(
      and(
        eq(schema.personGroups.id, id),
        eq(schema.personGroups.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspaceId = workspaces[0].id;
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const group = await loadGroup(id, workspaceId);
  if (!group)
    return NextResponse.json({ error: "Not found or not editable" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    color?: unknown;
  };

  const patch: { name?: string; color?: string } = {};
  if (typeof body.name === "string" && body.name.trim().length > 0)
    patch.name = body.name.trim().slice(0, 50);
  if (typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color))
    patch.color = body.color;

  if (!Object.keys(patch).length)
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const [updated] = await db
    .update(schema.personGroups)
    .set(patch)
    .where(eq(schema.personGroups.id, id))
    .returning();

  revalidateTag(`ws:${workspaceId}:person_groups`, "max");
  return NextResponse.json({
    group: {
      id: updated.id,
      workspaceId: updated.workspaceId,
      name: updated.name,
      color: updated.color,
      sortOrder: updated.sortOrder,
      builtin: false,
      createdAt: updated.createdAt.toISOString(),
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
  if (!workspaces.length)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspaceId = workspaces[0].id;
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const group = await loadGroup(id, workspaceId);
  if (!group)
    return NextResponse.json({ error: "Not found or not deletable" }, { status: 404 });

  // FK cascade removes person_group_members rows automatically.
  await db.delete(schema.personGroups).where(eq(schema.personGroups.id, id));

  revalidateTag(`ws:${workspaceId}:person_groups`, "max");
  return NextResponse.json({ ok: true as const });
}
