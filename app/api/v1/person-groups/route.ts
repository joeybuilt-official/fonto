// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET  /api/v1/person-groups — built-in groups + workspace-custom groups
// POST /api/v1/person-groups — create a custom group for the workspace
//
// T1.3 (fonto-perf-audit.md) — class-B workspace-scoped catalogue. The "no
// workspace" branch is keyed separately so it can never collide with a real
// workspace cache row. See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { and, isNull, or, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";

const loadGroups = (workspaceId: string | null) =>
  unstable_cache(
    async () =>
      db
        .select()
        .from(schema.personGroups)
        .where(
          workspaceId
            ? or(
                isNull(schema.personGroups.workspaceId),
                eq(schema.personGroups.workspaceId, workspaceId)
              )
            : isNull(schema.personGroups.workspaceId)
        )
        .orderBy(schema.personGroups.sortOrder, schema.personGroups.name),
    ["person-groups-list", workspaceId ?? "__builtins__"],
    {
      tags: workspaceId
        ? [`ws:${workspaceId}:person_groups`]
        : ["person_groups:builtins"],
      revalidate: 300,
    }
  )();

export async function GET(_request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  const workspaceId = workspaces[0]?.id ?? null;

  const groups = await loadGroups(workspaceId);

  return NextResponse.json({
    groups: groups.map((g) => ({
      id: g.id,
      workspaceId: g.workspaceId,
      name: g.name,
      color: g.color,
      sortOrder: g.sortOrder,
      builtin: g.workspaceId === null,
      createdAt: g.createdAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const workspaceId = workspaces[0].id;
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    color?: unknown;
  };

  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().slice(0, 50)
      : null;
  if (!name)
    return NextResponse.json({ error: "name is required" }, { status: 400 });

  const color =
    typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)
      ? body.color
      : "#6b7280";

  // Prevent duplicate names within the workspace (built-ins are unaffected).
  const existing = await db
    .select({ id: schema.personGroups.id })
    .from(schema.personGroups)
    .where(and(eq(schema.personGroups.workspaceId, workspaceId), eq(schema.personGroups.name, name)))
    .limit(1);
  if (existing.length)
    return NextResponse.json({ error: "A group with this name already exists" }, { status: 409 });

  const [group] = await db
    .insert(schema.personGroups)
    .values({ workspaceId, name, color })
    .returning();

  revalidateTag(`ws:${workspaceId}:person_groups`, "max");
  return NextResponse.json(
    {
      group: {
        id: group.id,
        workspaceId: group.workspaceId,
        name: group.name,
        color: group.color,
        sortOrder: group.sortOrder,
        builtin: false,
        createdAt: group.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
