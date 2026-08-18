// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Bulk add for the library multi-select.
//
//   POST /api/v1/collections/{id}/assets/bulk
//     Body: { assetIds: string[] }
//     → links every reachable asset id to the collection in ONE request.
//       Replaces the "fire N parallel POST /collections/{id}/assets" pattern.
//
// Mirrors the single-add handler's guards: the collection must belong to one of
// the caller's workspaces, `editor` is required, and each asset id is filtered
// to the caller's own workspaces (IDOR guard) before the link INSERT. Links are
// inserted onConflictDoNothing so re-adding an already-linked asset is a no-op.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

// Cap on a single batch; matches the /assets list MAX_LIMIT so one screenful of
// selection always fits in a single call.
const MAX_IDS = 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const parsed = await parseJson<{ assetIds?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const assetIds = Array.isArray(body.assetIds)
    ? Array.from(
        new Set(
          body.assetIds.filter((x): x is string => typeof x === "string" && x.length > 0)
        )
      )
    : [];
  if (assetIds.length === 0) {
    return NextResponse.json({ error: "assetIds[] required" }, { status: 400 });
  }
  if (assetIds.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Too many ids; max ${MAX_IDS} per request` },
      { status: 400 }
    );
  }

  const [collection] = await db
    .select({ workspaceId: schema.collections.workspaceId })
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.id, collectionId),
        inArray(schema.collections.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!collection) return NextResponse.json({ error: "Collection not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, collection.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  // IDOR guard: only link assets the caller can already read. A foreign-tenant
  // UUID smuggled into the body is dropped here, never linked.
  const reachable = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(inArray(schema.assets.id, assetIds), inArray(schema.assets.workspaceId, workspaceIds))
    );
  if (reachable.length === 0) {
    return NextResponse.json({ added: 0, requested: assetIds.length });
  }

  const inserted = await db
    .insert(schema.collectionAssets)
    .values(reachable.map((a) => ({ collectionId, assetId: a.id })))
    .onConflictDoNothing()
    .returning({ assetId: schema.collectionAssets.assetId });

  // T1.3' — adding links changes the cached collections/{id}/assets payload.
  revalidateTag(`ws:${collection.workspaceId}:collections`, "max");

  return NextResponse.json({ added: inserted.length, requested: assetIds.length }, { status: 201 });
}
