// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — /api/v1/stacks.
//   GET  → list every stack in the caller's primary workspace, with the
//          primary asset's filename + thumb key and the member count.
//          Used by the /app/stacks UI.
//   POST → create a stack from a confirmed group of assets (typically a
//          user-accepted suggestion). All members must live in the same
//          workspace as the caller and must not already be members of
//          another stack. Editor role required.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { createStack } from "@/lib/stacks/operations";
import { db, schema } from "@/lib/db";
import { eq, inArray, sql, desc } from "drizzle-orm";

interface CreateBody {
  assetIds?: unknown;
  primaryAssetId?: unknown;
  name?: unknown;
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ stacks: [] });
  const workspaceId = workspaces[0].id;

  // Join stacks → primary asset for filename + capturedAt; member count
  // comes from a correlated count over the assets.stack_id column.
  // (The fonto.stacks.member_count denorm could replace this subquery if
  // we add it; for the V1 UI a per-stack count(*) is cheap.)
  const rows = await db
    .select({
      id: schema.stacks.id,
      name: schema.stacks.name,
      primaryAssetId: schema.stacks.primaryAssetId,
      createdAt: schema.stacks.createdAt,
      primaryFilename: schema.assets.filename,
      primaryMimeType: schema.assets.mimeType,
      primaryCapturedAt: schema.assets.capturedAt,
      memberCount: sql<number>`(SELECT COUNT(*) FROM ${schema.assets} WHERE ${schema.assets.stackId} = ${schema.stacks.id})`,
    })
    .from(schema.stacks)
    .leftJoin(
      schema.assets,
      eq(schema.stacks.primaryAssetId, schema.assets.id)
    )
    .where(eq(schema.stacks.workspaceId, workspaceId))
    .orderBy(desc(schema.stacks.createdAt));

  return NextResponse.json({
    stacks: rows.map((r) => ({
      id: r.id,
      name: r.name,
      primaryAssetId: r.primaryAssetId,
      primaryFilename: r.primaryFilename,
      primaryMimeType: r.primaryMimeType,
      primaryCapturedAt: r.primaryCapturedAt,
      memberCount: Number(r.memberCount),
      createdAt: r.createdAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as CreateBody;
  const assetIds = Array.isArray(body.assetIds)
    ? body.assetIds.filter((x): x is string => typeof x === "string")
    : [];
  const primaryAssetId =
    typeof body.primaryAssetId === "string" ? body.primaryAssetId : "";
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : null;

  if (assetIds.length === 0 || !primaryAssetId) {
    return NextResponse.json(
      { error: "assetIds (non-empty) and primaryAssetId are required" },
      { status: 400 }
    );
  }
  if (!assetIds.includes(primaryAssetId)) {
    return NextResponse.json(
      { error: "primaryAssetId must be one of assetIds" },
      { status: 400 }
    );
  }

  // Look up the workspace of one of the listed assets to gate auth. The
  // createStack helper re-validates that ALL assets belong to that
  // workspace, so a malicious caller can't sneak in a foreign id.
  const [probe] = await db
    .select({ workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(inArray(schema.assets.id, assetIds))
    .limit(1);
  if (!probe) {
    return NextResponse.json({ error: "Assets not found" }, { status: 404 });
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.some((w) => w.id === probe.workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    probe.workspaceId,
    "editor"
  );
  if (!gate.ok) return gate.response;

  const result = await createStack({
    workspaceId: probe.workspaceId,
    assetIds,
    primaryAssetId,
    name,
  });
  if (!result.ok) {
    if (result.error.kind === "missing-or-foreign") {
      return NextResponse.json(
        { error: "One or more assets are missing or not in this workspace" },
        { status: 400 }
      );
    }
    if (result.error.kind === "already-stacked") {
      return NextResponse.json(
        {
          error: "One or more assets are already members of another stack",
          assetId: result.error.assetId,
        },
        { status: 409 }
      );
    }
    if (result.error.kind === "primary-not-in-set") {
      return NextResponse.json(
        { error: "primaryAssetId must be one of assetIds" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invalid stack" }, { status: 400 });
  }

  // Re-fetch the primary asset to surface its current denorm. (The
  // suggester typically already has this, but reads are cheap and the
  // shape is easier for clients to consume.)
  const [primary] = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.id, result.stack.primaryAssetId))
    .limit(1);

  return NextResponse.json(
    {
      stack: result.stack,
      assetIds: result.assetIds,
      primaryAsset: primary ?? null,
    },
    { status: 201 }
  );
}
