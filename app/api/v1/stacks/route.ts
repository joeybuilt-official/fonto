// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — POST /api/v1/stacks.
//
// Body: { assetIds: string[], primaryAssetId: string, name?: string }
// Creates a stack from a confirmed group of assets (typically a user-
// accepted suggestion). All members must live in the same workspace as
// the caller and must not already be members of another stack. Editor
// role required.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { createStack } from "@/lib/stacks/operations";
import { db, schema } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";

interface CreateBody {
  assetIds?: unknown;
  primaryAssetId?: unknown;
  name?: unknown;
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
