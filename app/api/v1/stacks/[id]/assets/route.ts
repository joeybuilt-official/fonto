// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — POST /api/v1/stacks/:id/assets
//
// Body: { assetIds: string[] }
// Adds one or more assets to an existing stack. All assets must be in the
// same workspace as the stack and must not already belong to a different
// stack. Idempotent against assets already in this stack.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import {
  findStackInWorkspaces,
  loadStackMembers,
} from "@/lib/stacks/operations";
import { loadAssetsForStack } from "@/lib/stacks/suggest";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { db, schema } from "@/lib/db";
import { inArray } from "drizzle-orm";

export async function POST(
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

  const body = (await request.json().catch(() => ({}))) as { assetIds?: unknown };
  const assetIds = Array.isArray(body.assetIds)
    ? body.assetIds.filter((x): x is string => typeof x === "string")
    : [];
  if (assetIds.length === 0) {
    return NextResponse.json({ error: "assetIds (non-empty) is required" }, { status: 400 });
  }

  const assets = await loadAssetsForStack(stack.workspaceId, assetIds);
  if (!assets) {
    return NextResponse.json(
      { error: "One or more assets are missing or not in this workspace" },
      { status: 400 }
    );
  }

  const foreign = assets.find(
    (a) => a.stackId !== null && a.stackId !== stack.id
  );
  if (foreign) {
    return NextResponse.json(
      {
        error: "One or more assets are already members of another stack",
        assetId: foreign.id,
      },
      { status: 409 }
    );
  }

  // Idempotent: setting stackId on rows that already point here is a no-op.
  await db
    .update(schema.assets)
    .set({ stackId: stack.id })
    .where(inArray(schema.assets.id, assetIds));

  const members = await loadStackMembers(stack);
  return NextResponse.json(
    { stack, assets: members.map(serializeAsset) },
    { status: 200 }
  );
}
