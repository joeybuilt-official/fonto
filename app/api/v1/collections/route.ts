// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
// T1.3 (fonto-perf-audit.md) — class-B workspace-scoped catalogue. GET is
// wrapped in `unstable_cache` keyed by workspaceId and tagged with
// `ws:<id>:collections`; mutating routes (POST here, plus
// /projects/[id] DELETE which detaches collections) call `revalidateTag`
// on success. See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, isNull } from "drizzle-orm";
import { emitWebhook } from "@/lib/webhooks/emit";
import { nextSeq } from "@/lib/db/seq";
import { cacheInvalidate, getCacheLayer } from "@/lib/cache/valkey";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

const COLLECTIONS_CACHE_TTL_SEC = 300;

// Next.js per-instance cache (in-process). The Valkey layer below sits on
// top and shares hits ACROSS instances + adds the stampede lock + metrics.
const loadCollections = (workspaceId: string) =>
  unstable_cache(
    async () =>
      db
        .select()
        .from(schema.collections)
        // Hide soft-deleted collections; the /sync feed still tombstones them.
        .where(and(eq(schema.collections.workspaceId, workspaceId), isNull(schema.collections.deletedAt)))
        .orderBy(schema.collections.createdAt),
    ["collections-list", workspaceId],
    { tags: [`ws:${workspaceId}:collections`], revalidate: 300 }
  )();

type CachedCollectionsResponse = { collections: unknown[] };

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ collections: [] });
  const workspaceId = workspaces[0].id;

  const cache = getCacheLayer<CachedCollectionsResponse>();
  const payload = await cache.getOrCompute(
    `collections:${workspaceId}`,
    COLLECTIONS_CACHE_TTL_SEC,
    async () => ({ collections: await loadCollections(workspaceId) }),
    {
      cacheName: "collections",
      workspaceId,
      tags: [`ws:${workspaceId}:collections`],
    },
  );

  return NextResponse.json(payload);
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }

  // Phase 3.1 — editor required to create a collection.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaces[0].id, "editor");
  if (!gate.ok) return gate.response;

  const parsed = await parseJson<{ name?: string; description?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  // Phase 2.3 — allocate delta-sync seq for this new collection.
  const seq = await nextSeq(workspaces[0].id, "collection");
  const [collection] = await db
    .insert(schema.collections)
    .values({
      workspaceId: workspaces[0].id,
      userId: user.id,
      name,
      description: String(body.description ?? ""),
      seq,
    })
    .returning();

  // Phase 2.4 — outbound webhook (collection.created).
  await emitWebhook(workspaces[0].id, "collection.created", {
    collectionId: collection.id,
    workspaceId: workspaces[0].id,
    name: collection.name,
    description: collection.description,
    createdAt: collection.createdAt.toISOString(),
  });

  revalidateTag(`ws:${workspaces[0].id}:collections`, "max");
  // T2.2 — also nuke the Valkey-layer entry (Next-cache only covers this
  // pod's in-memory copy).
  void cacheInvalidate(`ws:${workspaces[0].id}:collections`);
  return NextResponse.json({ collection }, { status: 201 });
}
