// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// T1.3 (docs/claude/platform/completed/perf-audit/perf-audit-plan.md) — class-B workspace-scoped catalogue. The
// per-asset tag-assign route is NOT class-B (per-asset cardinality) and
// stays out of this cache. The Valkey layer below is T2.2 and shares hits
// across instances; the `revalidate` export + `revalidateTag` POST hook are
// the Next.js-level convention. See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { parseJson } from "@/app/api/v1/_lib/parseJson";
import { createTag, listTags, TagRuleError } from "@/lib/tags/store";
import { emitWebhook } from "@/lib/webhooks/emit";
import { jsonSafe } from "@/lib/assets/createAssetRow";
import { cacheInvalidate, getCacheLayer } from "@/lib/cache/valkey";

const TAGS_CACHE_TTL_SEC = 300;

type CachedTagsResponse = { tags: unknown };

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ tags: [] });
  const workspaceIds = workspaces.map((w) => w.id);
  const sortedIds = [...workspaceIds].sort();
  const primaryWorkspaceId = sortedIds[0];

  const cache = getCacheLayer<CachedTagsResponse>();
  const payload = await cache.getOrCompute(
    `tags:${sortedIds.join(",")}`,
    TAGS_CACHE_TTL_SEC,
    async () => {
      const tags = await listTags(workspaceIds);
      // tags.seq is a bigint — JSON.stringify can't serialize BigInt, so run
      // the rows through jsonSafe (bigint → number/string) before responding.
      return { tags: jsonSafe(tags) };
    },
    {
      cacheName: "tags",
      workspaceId: primaryWorkspaceId,
      tags: sortedIds.map((id) => `ws:${id}:tags`),
    }
  );

  return NextResponse.json(payload);
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  // Phase 3.1 — editor required to create tags.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const parsed = await parseJson<{ name?: string; color?: string; parentId?: string | null }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  // M10 / ADR 0013 — the parent's existence and the depth cap are the tag
  // tree's rules, enforced where the tree lives (`lib/tags/store.ts`).
  let tag;
  try {
    tag = await createTag(workspaceId, {
      name: body.name,
      color: body.color,
      parentId: body.parentId ?? null,
    });
  } catch (err) {
    if (err instanceof TagRuleError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // Phase 2.4 — outbound webhook (tag.created).
  await emitWebhook(workspaceId, "tag.created", {
    tagId: tag.id,
    workspaceId,
    name: tag.name,
    color: tag.color,
    aiSuggested: tag.aiSuggested,
    createdAt: tag.createdAt.toISOString(),
  });

  // T1.3 — Next.js cache tag invalidation (in-process unstable_cache).
  revalidateTag(`ws:${workspaceId}:tags`, "max");
  // T2.2 — invalidate Valkey-layer cache (fire-and-forget; cross-instance).
  void cacheInvalidate(`ws:${workspaceId}:tags`);

  return NextResponse.json({ tag }, { status: 201 });
}
