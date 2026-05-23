// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — POST /api/v1/stacks/suggestions/accept
//
// Body: { assetIds: string[], primaryAssetId?: string, name?: string }
// Accepts a suggestion (typically one returned by GET
// /api/v1/stacks/suggestions) and creates the stack. Primary defaults to
// the first asset in the suggestion if not specified.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { createStack } from "@/lib/stacks/operations";
import { db, schema } from "@/lib/db";
import { inArray } from "drizzle-orm";

interface AcceptBody {
  assetIds?: unknown;
  primaryAssetId?: unknown;
  name?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as AcceptBody;
  const assetIds = Array.isArray(body.assetIds)
    ? body.assetIds.filter((x): x is string => typeof x === "string")
    : [];
  if (assetIds.length === 0) {
    return NextResponse.json({ error: "assetIds (non-empty) is required" }, { status: 400 });
  }
  const primaryAssetId =
    typeof body.primaryAssetId === "string" && body.primaryAssetId.length > 0
      ? body.primaryAssetId
      : assetIds[0];
  if (!assetIds.includes(primaryAssetId)) {
    return NextResponse.json(
      { error: "primaryAssetId must be one of assetIds" },
      { status: 400 }
    );
  }
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : null;

  // Determine the workspace from an asset id; createStack revalidates.
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
    if (result.error.kind === "already-stacked") {
      return NextResponse.json(
        {
          error: "One or more assets are already members of another stack",
          assetId: result.error.assetId,
        },
        { status: 409 }
      );
    }
    if (result.error.kind === "missing-or-foreign") {
      return NextResponse.json(
        { error: "One or more assets are missing or not in this workspace" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invalid suggestion" }, { status: 400 });
  }

  return NextResponse.json(
    { stack: result.stack, assetIds: result.assetIds },
    { status: 201 }
  );
}
