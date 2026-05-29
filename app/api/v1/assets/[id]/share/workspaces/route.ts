// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b — cross-workspace asset shares (C5 reference model).
//
//   GET  /api/v1/assets/:id/share/workspaces
//     List active (non-revoked) cross-workspace shares for this asset.
//     Caller must have membership in the asset's SOURCE workspace.
//
//   POST /api/v1/assets/:id/share/workspaces
//     Body: { targetWorkspaceId, accessLevel? }
//     Grant the target workspace access to this asset. Caller must
//     have editor+ on the SOURCE workspace AND any role on the target
//     workspace (you can only share into workspaces you're a member of).
//     `accessLevel` defaults to 'viewer'; max is 'editor'.
//     Idempotent: re-POSTing for an existing active share is a no-op.
//
// Per-target-workspace revoke lives at .../share/workspaces/[targetWorkspaceId].
//
// Path naming: kept under `share/workspaces/` rather than the plan's
// originally-proposed `share/` so this doesn't collide with the existing
// public share-LINK endpoint at app/api/v1/assets/[id]/share/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import {
  getUserWorkspaceRole,
  requireWorkspaceAccessOrResponse,
  type WorkspaceRole,
} from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { notifyWorkspaceMembers } from "@/lib/notifications/push";
import { emitActivity } from "@/lib/activity/emit";

const VALID_ACCESS_LEVELS = ["viewer", "commenter", "contributor", "editor"] as const;
type SharedAccessLevel = (typeof VALID_ACCESS_LEVELS)[number];

function parseAccessLevel(value: unknown): SharedAccessLevel | null {
  return typeof value === "string" && (VALID_ACCESS_LEVELS as readonly string[]).includes(value)
    ? (value as SharedAccessLevel)
    : null;
}

async function loadAssetForCaller(
  assetId: string,
  userId: string
): Promise<{ id: string; workspaceId: string } | null> {
  const workspaces = await getUserWorkspaces(userId);
  if (!workspaces.length) return null;
  const workspaceIds = workspaces.map((w) => w.id);
  const [row] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  return row ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const asset = await loadAssetForCaller(assetId, user.id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await db
    .select()
    .from(schema.sharedAssets)
    .where(
      and(
        eq(schema.sharedAssets.assetId, assetId),
        eq(schema.sharedAssets.sourceWorkspaceId, asset.workspaceId),
        isNull(schema.sharedAssets.revokedAt)
      )
    );

  return NextResponse.json({
    shares: rows.map((r) => ({
      id: r.id,
      assetId: r.assetId,
      sourceWorkspaceId: r.sourceWorkspaceId,
      targetWorkspaceId: r.targetWorkspaceId,
      accessLevel: r.accessLevel,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const asset = await loadAssetForCaller(assetId, user.id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Sharing is an editor-level action on the SOURCE workspace.
  const gate = await requireWorkspaceAccessOrResponse(user.id, asset.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as {
    targetWorkspaceId?: unknown;
    accessLevel?: unknown;
  } | null;
  if (!body || typeof body.targetWorkspaceId !== "string") {
    return NextResponse.json({ error: "targetWorkspaceId required" }, { status: 400 });
  }
  if (body.targetWorkspaceId === asset.workspaceId) {
    // CHECK in migration 0028 would reject this too; surface a friendlier
    // error than the Postgres constraint name.
    return NextResponse.json(
      { error: "Cannot share an asset to its own workspace" },
      { status: 400 }
    );
  }

  // Caller must be a member of the target workspace (any role) — you
  // can only share into workspaces you have visibility into. Otherwise
  // we'd let editors leak assets into arbitrary workspace IDs they've
  // guessed.
  const targetRole: WorkspaceRole | null = await getUserWorkspaceRole(
    user.id,
    body.targetWorkspaceId
  );
  if (!targetRole) {
    return NextResponse.json(
      { error: "Not a member of target workspace" },
      { status: 403 }
    );
  }

  const requestedAccess = parseAccessLevel(body.accessLevel) ?? "viewer";

  // Idempotent: if an active share already exists for (asset, target),
  // return the existing row instead of letting the partial unique index
  // throw. Lets the UI safely re-issue the call after a flaky response.
  const [existing] = await db
    .select()
    .from(schema.sharedAssets)
    .where(
      and(
        eq(schema.sharedAssets.assetId, assetId),
        eq(schema.sharedAssets.targetWorkspaceId, body.targetWorkspaceId),
        isNull(schema.sharedAssets.revokedAt)
      )
    )
    .limit(1);
  if (existing) {
    return NextResponse.json(
      {
        share: {
          id: existing.id,
          assetId: existing.assetId,
          sourceWorkspaceId: existing.sourceWorkspaceId,
          targetWorkspaceId: existing.targetWorkspaceId,
          accessLevel: existing.accessLevel,
          createdBy: existing.createdBy,
          createdAt: existing.createdAt.toISOString(),
        },
        alreadyShared: true,
      },
      { status: 200 }
    );
  }

  const [inserted] = await db
    .insert(schema.sharedAssets)
    .values({
      assetId,
      sourceWorkspaceId: asset.workspaceId,
      targetWorkspaceId: body.targetWorkspaceId,
      accessLevel: requestedAccess,
      createdBy: user.id,
    })
    .returning();

  // Phase 7a — activity feed entry in the TARGET workspace so its members
  // see the inbound share in their Updates feed (parallels the push below).
  void emitActivity({
    workspaceId: body.targetWorkspaceId,
    actorUserId: user.id,
    kind: "asset.shared",
    targetType: "asset",
    targetId: assetId,
    payload: {
      assetId,
      sourceWorkspaceId: asset.workspaceId,
      accessLevel: requestedAccess,
    },
  });

  // Phase 6.4 — notify the TARGET workspace's members that an asset was
  // shared in (minus the sharer, who is a target member by the check above).
  // C10 real-time; fire-and-forget; no-op until FCM_SERVER_KEY is set.
  void notifyWorkspaceMembers(
    body.targetWorkspaceId,
    {
      title: "Asset shared with your workspace",
      body: "A new asset is now available in your workspace.",
      data: { type: "share", assetId, sharedAssetId: inserted.id },
    },
    { exceptUserId: user.id }
  );

  return NextResponse.json(
    {
      share: {
        id: inserted.id,
        assetId: inserted.assetId,
        sourceWorkspaceId: inserted.sourceWorkspaceId,
        targetWorkspaceId: inserted.targetWorkspaceId,
        accessLevel: inserted.accessLevel,
        createdBy: inserted.createdBy,
        createdAt: inserted.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
