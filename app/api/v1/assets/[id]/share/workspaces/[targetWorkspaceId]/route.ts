// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b — revoke a cross-workspace share.
//
//   DELETE /api/v1/assets/:id/share/workspaces/:targetWorkspaceId
//     Soft-revoke (sets revoked_at). Idempotent — revoking an already-
//     revoked share returns 204.
//
// Authz: editor+ on the SOURCE workspace. The target workspace's
// recipients have no say in revocation — that's by design (the source
// owner retains control of their assets).

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; targetWorkspaceId: string }> }
) {
  const { id: assetId, targetWorkspaceId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve the source workspace via the asset row, scoped to caller's
  // memberships.
  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, asset.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db
    .update(schema.sharedAssets)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.sharedAssets.assetId, assetId),
        eq(schema.sharedAssets.sourceWorkspaceId, asset.workspaceId),
        eq(schema.sharedAssets.targetWorkspaceId, targetWorkspaceId),
        isNull(schema.sharedAssets.revokedAt)
      )
    );

  return new NextResponse(null, { status: 204 });
}
