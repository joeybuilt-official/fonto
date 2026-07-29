// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — /api/v1/stacks/:id
//   GET    — stack + members sorted primary-first
//   PATCH  — { primaryAssetId?, name? } update
//   DELETE — un-stack all members then delete the stack row

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import {
  findStackInWorkspaces,
  loadStackMembers,
  sortStackMembers,
} from "@/lib/stacks/operations";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  const stack = await findStackInWorkspaces(
    id,
    workspaces.map((w) => w.id)
  );
  if (!stack) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Viewer is enough to read.
  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    stack.workspaceId,
    "viewer"
  );
  if (!gate.ok) return gate.response;

  const members = await loadStackMembers(stack);
  return NextResponse.json({
    stack,
    assets: members.map(serializeAsset),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  const stack = await findStackInWorkspaces(
    id,
    workspaces.map((w) => w.id)
  );
  if (!stack) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    stack.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as {
    primaryAssetId?: unknown;
    name?: unknown;
  };

  const patch: Partial<typeof schema.stacks.$inferInsert> = {};

  if (typeof body.primaryAssetId === "string") {
    // Verify the proposed primary is actually a member.
    const [member] = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.id, body.primaryAssetId),
          eq(schema.assets.stackId, stack.id)
        )
      )
      .limit(1);
    if (!member) {
      return NextResponse.json(
        { error: "primaryAssetId must be a member of this stack" },
        { status: 400 }
      );
    }
    patch.primaryAssetId = body.primaryAssetId;
  }

  if (body.name === null) {
    patch.name = null;
  } else if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    patch.name = trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ stack });
  }

  patch.updatedAt = new Date();

  const [updated] = await db
    .update(schema.stacks)
    .set(patch)
    .where(eq(schema.stacks.id, stack.id))
    .returning();

  const members = await loadStackMembers(updated);
  return NextResponse.json({
    stack: updated,
    assets: sortStackMembers(members, updated.primaryAssetId).map(serializeAsset),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  const stack = await findStackInWorkspaces(
    id,
    workspaces.map((w) => w.id)
  );
  if (!stack) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    stack.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  // Un-stack every member, then drop the stack row. Order matters: clear
  // members first so a stale read can't see "stack_id pointing nowhere".
  await db
    .update(schema.assets)
    .set({ stackId: null })
    .where(eq(schema.assets.stackId, stack.id));

  await db.delete(schema.stacks).where(eq(schema.stacks.id, stack.id));

  return NextResponse.json({ ok: true });
}
