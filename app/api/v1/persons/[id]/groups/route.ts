// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// PUT /api/v1/persons/:id/groups — replace the person's group memberships.
// Body: { groupIds: string[] }
// An empty array removes all memberships.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [person] = await db
    .select({ id: schema.persons.id, workspaceId: schema.persons.workspaceId })
    .from(schema.persons)
    .where(and(eq(schema.persons.id, id), inArray(schema.persons.workspaceId, workspaceIds)))
    .limit(1);
  if (!person) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, person.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as { groupIds?: unknown };
  if (!Array.isArray(body.groupIds) || !body.groupIds.every((g) => typeof g === "string"))
    return NextResponse.json({ error: "groupIds must be string[]" }, { status: 400 });

  const groupIds = body.groupIds as string[];

  // Validate: each requested group must be built-in (workspace_id IS NULL)
  // or belong to this workspace.
  if (groupIds.length > 0) {
    const valid = await db
      .select({ id: schema.personGroups.id })
      .from(schema.personGroups)
      .where(
        and(
          inArray(schema.personGroups.id, groupIds),
          or(isNull(schema.personGroups.workspaceId), eq(schema.personGroups.workspaceId, person.workspaceId))
        )
      );
    if (valid.length !== groupIds.length)
      return NextResponse.json({ error: "One or more groupIds are invalid" }, { status: 400 });
  }

  // Replace: delete all existing memberships then insert new ones.
  await db
    .delete(schema.personGroupMembers)
    .where(eq(schema.personGroupMembers.personId, person.id));

  if (groupIds.length > 0) {
    await db
      .insert(schema.personGroupMembers)
      .values(groupIds.map((gid) => ({ personId: person.id, groupId: gid })));
  }

  return NextResponse.json({ ok: true as const, groupIds });
}
