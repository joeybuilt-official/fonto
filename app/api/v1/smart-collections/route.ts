// SPDX-License-Identifier: AGPL-3.0-only
//
// T1.3 (fonto-perf-audit.md) — class-B workspace-scoped catalogue. GET is
// wrapped in `unstable_cache` keyed by the sorted workspaceId list and
// tagged with `ws:<id>:smart_collections` per workspace; mutating routes
// (POST here, PATCH/DELETE on /[id]) call `revalidateTag` on success.
// See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { parseJson } from "@/app/api/v1/_lib/parseJson";
import { inArray } from "drizzle-orm";
import { cacheInvalidate, getCacheLayer } from "@/lib/cache/valkey";

const SMART_COLLECTIONS_CACHE_TTL_SEC = 300;

type CachedSmartCollectionsResponse = { smartCollections: unknown[] };

const loadSmartCollections = (workspaceIds: string[]) => {
  const key = [...workspaceIds].sort().join(",");
  return unstable_cache(
    async () =>
      db
        .select()
        .from(schema.smartCollections)
        .where(inArray(schema.smartCollections.workspaceId, workspaceIds))
        .orderBy(schema.smartCollections.createdAt),
    ["smart-collections-list", key],
    {
      tags: workspaceIds.map((id) => `ws:${id}:smart_collections`),
      revalidate: 300,
    }
  )();
};

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ smartCollections: [] });
  const workspaceIds = workspaces.map((w) => w.id);
  const sortedIds = [...workspaceIds].sort();
  const primaryWorkspaceId = sortedIds[0];

  const cache = getCacheLayer<CachedSmartCollectionsResponse>();
  const payload = await cache.getOrCompute(
    `smart_collections:${sortedIds.join(",")}`,
    SMART_COLLECTIONS_CACHE_TTL_SEC,
    async () => ({
      smartCollections: await loadSmartCollections(workspaceIds),
    }),
    {
      cacheName: "smart_collections",
      workspaceId: primaryWorkspaceId,
      tags: sortedIds.map((id) => `ws:${id}:smart_collections`),
    },
  );

  return NextResponse.json(payload);
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Phase 3.1 — editor required to create smart collections.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaces[0].id, "editor");
  if (!gate.ok) return gate.response;

  const parsed = await parseJson<{ name?: string; query?: Record<string, unknown> }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [sc] = await db
    .insert(schema.smartCollections)
    .values({
      workspaceId: workspaces[0].id,
      userId: user.id,
      name,
      query: body.query ?? {},
    })
    .returning();

  revalidateTag(`ws:${workspaces[0].id}:smart_collections`, "max");
  // T2.2 — also flush the Valkey-layer entry.
  void cacheInvalidate(`ws:${workspaces[0].id}:smart_collections`);
  return NextResponse.json({ smartCollection: sc }, { status: 201 });
}
