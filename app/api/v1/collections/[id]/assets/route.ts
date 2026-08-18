// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// T1.3' (fonto-perf-audit.md) — class-B aggregate. GET returns the assets
// linked to a collection (one row per asset), so the cache key includes the
// collection id + the resolved scope param, and the tag list covers BOTH
// `:collections` (link table changes) AND `:assets` (asset CRUD).
// See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { parseScopeParam, scopeCond, type ScopeFilter } from "@/lib/scope";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

const loadCollectionAssets = (
  collectionId: string,
  workspaceIds: string[],
  scope: ScopeFilter,
) => {
  const sortedIds = [...workspaceIds].sort();
  return unstable_cache(
    async () => {
      const collection = await db
        .select()
        .from(schema.collections)
        .where(
          and(
            eq(schema.collections.id, collectionId),
            inArray(schema.collections.workspaceId, workspaceIds)
          )
        )
        .limit(1);

      if (!collection.length) return { notFound: true as const };

      // ADR 0008 — scope default; resolved from the cache-key arg so the
      // filter lives in the key rather than a captured URLSearchParams.
      const __sc = scopeCond(scope);
      const rows = await db
        .select({ asset: schema.assets })
        .from(schema.collectionAssets)
        .innerJoin(schema.assets, eq(schema.collectionAssets.assetId, schema.assets.id))
        .where(
          and(
            eq(schema.collectionAssets.collectionId, collectionId),
            // Defense-in-depth: never surface an asset outside the caller's
            // workspaces even if a foreign link row somehow exists.
            inArray(schema.assets.workspaceId, workspaceIds),
            __sc,
          ),
        );

      return { assets: rows.map((r) => r.asset) };
    },
    ["collection-assets", collectionId, sortedIds.join(","), scope],
    {
      tags: sortedIds.flatMap((id) => [
        `ws:${id}:collections`,
        `ws:${id}:assets`,
      ]),
      revalidate: 300,
    },
  )();
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const scope = parseScopeParam(new URL(_request.url).searchParams);
  const result = await loadCollectionAssets(collectionId, workspaceIds, scope);
  if ("notFound" in result) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ assets: result.assets });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const parsed = await parseJson<{ assetId?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body.assetId) return NextResponse.json({ error: "assetId required" }, { status: 400 });

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.id, collectionId),
        inArray(schema.collections.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!collection) return NextResponse.json({ error: "Collection not found" }, { status: 404 });

  // Phase 3.1 — editor required to mutate collection contents.
  const gate = await requireWorkspaceAccessOrResponse(user.id, collection.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  // IDOR guard: the asset being linked must belong to one of the caller's
  // workspaces. Without this a member could smuggle a foreign tenant's asset
  // UUID into their own collection and then read its serialized row (GET) or
  // download its original bytes (zip export).
  const [asset] = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, body.assetId),
        inArray(schema.assets.workspaceId, workspaceIds),
      ),
    )
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  const [link] = await db
    .insert(schema.collectionAssets)
    .values({ collectionId, assetId: body.assetId })
    .onConflictDoNothing()
    .returning();

  // T1.3' — adding an asset link changes the cached `collections/[id]/assets`
  // payload (and `collections/stats` if we ever surface link counts there).
  revalidateTag(`ws:${collection.workspaceId}:collections`, "max");
  return NextResponse.json({ link }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const { searchParams } = request.nextUrl;
  const assetId = searchParams.get("assetId");
  if (!assetId) return NextResponse.json({ error: "assetId required" }, { status: 400 });

  // Phase 3.1 — editor required to remove assets from a collection. Look up
  // the collection's workspace first so the gate can run against the right id.
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
  if (!collection) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, collection.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db
    .delete(schema.collectionAssets)
    .where(
      and(
        eq(schema.collectionAssets.collectionId, collectionId),
        eq(schema.collectionAssets.assetId, assetId)
      )
    );

  // T1.3' — removing an asset link changes the cached collection-assets list.
  revalidateTag(`ws:${collection.workspaceId}:collections`, "max");
  return NextResponse.json({ removed: true });
}
