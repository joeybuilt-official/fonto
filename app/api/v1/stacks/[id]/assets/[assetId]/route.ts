// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — DELETE /api/v1/stacks/:id/assets/:assetId
//
// Removes one asset from a stack (sets `stack_id = NULL`). If the removed
// asset was the stack's `primaryAssetId`, the next-oldest remaining member
// is promoted to primary. If no members remain, the stack row itself is
// deleted.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import {
  findStackInWorkspaces,
  reconcileStackAfterRemoval,
} from "@/lib/stacks/operations";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id, assetId } = await params;
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

  // Verify the asset is currently a member.
  const [member] = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, assetId),
        eq(schema.assets.stackId, stack.id)
      )
    )
    .limit(1);
  if (!member) {
    return NextResponse.json(
      { error: "Asset is not a member of this stack" },
      { status: 404 }
    );
  }

  await db
    .update(schema.assets)
    .set({ stackId: null })
    .where(eq(schema.assets.id, assetId));

  const remaining = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, stack.workspaceId),
        eq(schema.assets.stackId, stack.id)
      )
    );

  const result = await reconcileStackAfterRemoval(stack, remaining, assetId);

  return NextResponse.json({
    ok: true,
    deleted: result.deleted,
    newPrimaryAssetId: result.newPrimaryAssetId,
  });
}
