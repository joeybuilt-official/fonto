// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b — list assets that have been shared INTO the caller's active
// workspace from other workspaces (C5 reference model).
//
//   GET /api/v1/workspace/shared-with-me
//     Newest-first list of shared assets. Each row carries a
//     `sharedFrom` object so the UI can render a "from @alice / Project
//     Foo" badge.
//
// Authz: any membership on the caller's active workspace (uses the
// same workspaces[0] convention as the rest of the workspace API).
// Source workspace details (name, slug) are surfaced for the badge but
// the caller's identity is never compared against the source workspace
// — that's the whole point of a shared reference.

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { serializeAsset } from "@/lib/assets/createAssetRow";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const targetWorkspaceId = workspaces[0].id;

  // Join shared_assets → assets → workspaces (source) in one round trip
  // so the UI can render the source-workspace badge without an N+1
  // follow-up.
  const rows = await db
    .select({
      asset: schema.assets,
      share: schema.sharedAssets,
      sourceWorkspace: schema.workspaces,
    })
    .from(schema.sharedAssets)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.sharedAssets.assetId))
    .innerJoin(
      schema.workspaces,
      eq(schema.workspaces.id, schema.sharedAssets.sourceWorkspaceId)
    )
    .where(
      and(
        eq(schema.sharedAssets.targetWorkspaceId, targetWorkspaceId),
        isNull(schema.sharedAssets.revokedAt)
      )
    )
    .orderBy(desc(schema.sharedAssets.createdAt));

  return NextResponse.json({
    assets: rows.map((r) => ({
      ...serializeAsset(r.asset),
      sharedFrom: {
        workspaceId: r.sourceWorkspace.id,
        workspaceName: r.sourceWorkspace.name,
        accessLevel: r.share.accessLevel,
        createdBy: r.share.createdBy,
        sharedAt: r.share.createdAt.toISOString(),
      },
    })),
  });
}
