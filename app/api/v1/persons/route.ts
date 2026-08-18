// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — GET /api/v1/persons.
//
// Lists the caller's primary workspace's persons (id, name, cover_face_id,
// instance_count, sample face thumbnail URL), ordered by instance_count desc.
// Hidden persons are excluded by default; pass `?hidden=true` to include.
//
// The sample thumbnail URL points at the asset the cover face belongs to —
// crop is rendered client-side via the bbox on the face row (the People grid
// uses a CSS object-position / background-position trick). For asset URL
// resolution we reuse the existing `/api/v1/assets/:id/url` helper.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, ilike, inArray, sql, exists } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { propagateNamedPerson } from "@/lib/faces/propagate";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { cacheInvalidate, getCacheLayer } from "@/lib/cache/valkey";
import { revalidateTag } from "next/cache";

const PERSONS_CACHE_TTL_SEC = 300;
// Cover-crop presign TTLs. The dedicated face crop + asset preview are
// immutable, content-addressed derivatives → sign toward the SigV4 ceiling
// (7 days) so a re-list doesn't churn the URL. The original fallback is
// sensitive + full-res, so it stays short-lived.
const COVER_TTL_DERIVATIVE_SEC = 7 * 24 * 60 * 60; // 604800
const COVER_TTL_ORIGINAL_SEC = 3600; // 1 hour

type CachedPersonsResponse = { persons: PersonOut[] };

interface PersonOut {
  id: string;
  workspaceId: string;
  name: string | null;
  coverFaceId: string | null;
  instanceCount: number;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  coverAssetId: string | null;
  coverBbox: { x: number; y: number; w: number; h: number } | null;
  coverFaceCropKey: string | null;
  coverFaceCropUrl: string | null;
  coverFaceCropSignedUrl: string | null;
  groupIds: string[];
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ persons: [] });
  const workspaceIds = workspaces.map((w) => w.id);
  const sortedIds = [...workspaceIds].sort();
  const primaryWorkspaceId = sortedIds[0];

  const includeHidden = request.nextUrl.searchParams.get("hidden") === "true";
  const filterGroupId = request.nextUrl.searchParams.get("group_id");
  // Singleton clusters are mostly false-positive detections — random face
  // fragments on objects, partial faces, etc. They explode the People grid
  // into thousands of low-value cards (4k+ on the seed library, vs ~218
  // clusters at instance_count >= 5). Default to >=2; let admin tooling
  // opt-in via `?include_singletons=true`.
  const includeSingletons =
    request.nextUrl.searchParams.get("include_singletons") === "true";
  const minInstances = includeSingletons ? 1 : 2;

  // Merge-picker support. `?limit=` caps the returned clusters (max 500);
  // `?q=` does a case-insensitive substring match on the person NAME (unnamed
  // clusters drop out when q is set — you merge INTO a named person). Both fold
  // into the cache key so a filtered response never masks the full grid.
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limitParsed = limitRaw == null ? NaN : Number.parseInt(limitRaw, 10);
  const limit =
    Number.isInteger(limitParsed) && limitParsed > 0 ? Math.min(limitParsed, 500) : null;
  const nameQuery = (request.nextUrl.searchParams.get("q") ?? "").trim();

  const cacheKey = `persons:${sortedIds.join(",")}:h=${includeHidden ? 1 : 0}:g=${filterGroupId ?? ""}:s=${includeSingletons ? 1 : 0}:l=${limit ?? ""}:q=${nameQuery}`;
  const cache = getCacheLayer<CachedPersonsResponse>();
  const payload = await cache.getOrCompute(
    cacheKey,
    PERSONS_CACHE_TTL_SEC,
    async () => ({ persons: await buildPersons() }),
    {
      cacheName: "persons",
      workspaceId: primaryWorkspaceId,
      // T1.3' — instance_count comes off asset-side face_instance flows, so an
      // asset-side mutation must also evict this cache. See CACHE-CONVENTION.md.
      tags: sortedIds.flatMap((id) => [`ws:${id}:persons`, `ws:${id}:assets`]),
    },
  );
  return NextResponse.json(payload);

  async function buildPersons(): Promise<PersonOut[]> {

  // Default grid excludes hidden persons AND empty/singleton clusters.
  // A re-cluster zeroes-out persons whose faces were all detached (e.g.
  // the junk-screenshot prune) but keeps the row to preserve any
  // name/hidden edits — those rows must never render as ghost cards.
  const baseWhere = includeHidden
    ? inArray(schema.persons.workspaceId, workspaceIds)
    : and(
        inArray(schema.persons.workspaceId, workspaceIds),
        eq(schema.persons.hidden, false),
        gt(schema.persons.instanceCount, minInstances - 1)
      );

  // Optional name substring filter (merge picker). `and(x, undefined)` is a
  // no-op in drizzle, so an empty query leaves the grid untouched.
  const nameCond =
    nameQuery !== ""
      ? ilike(
          schema.persons.name,
          `%${nameQuery.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
        )
      : undefined;

  const where = and(
    filterGroupId
      ? and(
          baseWhere,
          exists(
            db
              .select({ one: sql`1` })
              .from(schema.personGroupMembers)
              .where(
                and(
                  eq(schema.personGroupMembers.personId, schema.persons.id),
                  eq(schema.personGroupMembers.groupId, filterGroupId)
                )
              )
          )
        )
      : baseWhere,
    nameCond
  );

  const personsQuery = db
    .select()
    .from(schema.persons)
    .where(where)
    .orderBy(
      sql`(${schema.persons.name} IS NOT NULL) DESC`,
      desc(schema.persons.instanceCount)
    );
  // Default cap: the People grid is a curated set — named people first (the
  // ORDER BY above), then the most-photographed clusters. Without a cap a large
  // library returns thousands of clusters, and a client that resolves each
  // cover-crop URL upfront (the mobile People tab) fires thousands of
  // concurrent requests, exhausts its sockets, and the whole grid fails to
  // load. `?limit=` overrides (up to 500); this default also bounds the
  // `?include_singletons=true` path.
  const DEFAULT_PERSONS_LIMIT = 200;
  const rows = await personsQuery.limit(limit ?? DEFAULT_PERSONS_LIMIT);

  // Resolve cover face -> asset + bbox in a single batch lookup.
  const coverFaceIds = rows
    .map((r) => r.coverFaceId)
    .filter((id): id is string => typeof id === "string");

  const facesById = new Map<
    string,
    { assetId: string; bbox: unknown; faceCropKey: string | null; coverUrl: string | null }
  >();
  if (coverFaceIds.length > 0) {
    const faceRows = await db
      .select({
        id: schema.faceInstances.id,
        assetId: schema.faceInstances.assetId,
        bbox: schema.faceInstances.bbox,
        faceCropKey: schema.faceInstances.faceCropKey,
        workspaceId: schema.assets.workspaceId,
        filename: schema.assets.filename,
        previewKey: schema.assets.previewKey,
      })
      .from(schema.faceInstances)
      .innerJoin(schema.assets, eq(schema.faceInstances.assetId, schema.assets.id))
      .where(inArray(schema.faceInstances.id, coverFaceIds));
    // Resolve + presign the cover crop INLINE so the People grid renders each
    // card without a per-card GET /assets/{id}/url round-trip. Prefer the
    // dedicated square face crop; fall back to the asset preview, then the
    // original, so a cover always resolves even mid-backfill.
    await Promise.all(
      faceRows.map(async (f) => {
        let key: string;
        let expiresIn: number;
        if (f.faceCropKey) {
          key = f.faceCropKey;
          expiresIn = COVER_TTL_DERIVATIVE_SEC;
        } else if (f.previewKey) {
          key = f.previewKey;
          expiresIn = COVER_TTL_DERIVATIVE_SEC;
        } else {
          key = assetStorageKey(f.workspaceId, f.assetId, f.filename);
          expiresIn = COVER_TTL_ORIGINAL_SEC;
        }
        let coverUrl: string | null = null;
        try {
          coverUrl = await storage().presignGet(key, { expiresIn });
        } catch {
          // A sign failure must not sink the whole grid — the card falls back
          // to the client's bbox/CSS crop off `coverAssetId` + `coverBbox`.
          coverUrl = null;
        }
        facesById.set(f.id, {
          assetId: f.assetId,
          bbox: f.bbox,
          faceCropKey: f.faceCropKey,
          coverUrl,
        });
      })
    );
  }

  // Batch-load group memberships for all returned persons.
  const personIds = rows.map((r) => r.id);
  const groupsByPerson = new Map<string, string[]>();
  if (personIds.length > 0) {
    const memberRows = await db
      .select({
        personId: schema.personGroupMembers.personId,
        groupId: schema.personGroupMembers.groupId,
      })
      .from(schema.personGroupMembers)
      .where(inArray(schema.personGroupMembers.personId, personIds));
    for (const m of memberRows) {
      const list = groupsByPerson.get(m.personId) ?? [];
      list.push(m.groupId);
      groupsByPerson.set(m.personId, list);
    }
  }

  const persons: PersonOut[] = rows.map((p) => {
    const cover = p.coverFaceId ? facesById.get(p.coverFaceId) : undefined;
    const bb = cover?.bbox as
      | { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
      | undefined;
    const bbox =
      bb &&
      typeof bb.x === "number" &&
      typeof bb.y === "number" &&
      typeof bb.w === "number" &&
      typeof bb.h === "number"
        ? { x: bb.x, y: bb.y, w: bb.w, h: bb.h }
        : null;
    return {
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      coverFaceId: p.coverFaceId,
      instanceCount: p.instanceCount,
      hidden: p.hidden,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      coverAssetId: cover?.assetId ?? null,
      coverBbox: bbox,
      coverFaceCropKey: cover?.faceCropKey ?? null,
      // RELATIVE resolve URL — mobile clients call resolveSignedUrl() on this,
      // so it MUST stay relative for backward-compat with installed apps.
      coverFaceCropUrl:
        cover && cover.faceCropKey && p.coverFaceId
          ? `/api/v1/assets/${cover.assetId}/url?variant=face&faceId=${p.coverFaceId}`
          : null,
      // Absolute pre-signed R2 URL resolved server-side — the web grid uses
      // this to skip the per-card round-trip. NULL when no cover / sign failed.
      coverFaceCropSignedUrl: cover?.coverUrl ?? null,
      groupIds: groupsByPerson.get(p.id) ?? [],
    };
  });

    return persons;
  }
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    workspaceId?: unknown;
  };

  const workspaceId =
    typeof body.workspaceId === "string" &&
    workspaces.some((w) => w.id === body.workspaceId)
      ? (body.workspaceId as string)
      : workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : null;

  const [person] = await db
    .insert(schema.persons)
    .values({ workspaceId, name, instanceCount: 0 })
    .returning();

  // Phase 1 (faces/UX), D2 — naming a NEW person is the primary "name a face"
  // path on mobile; trigger the hybrid match pass so tight matches auto-assign
  // and the borderline band is surfaced for review. Fire-and-forget: a slow /
  // failed pgvector sweep must not block the create response (mirrors PATCH).
  if (name) {
    propagateNamedPerson(person.id, person.workspaceId).catch(() => {});
  }

  // T1.3' — Next-cache layer invalidate (per-pod unstable_cache).
  revalidateTag(`ws:${workspaceId}:persons`, "max");
  // T2.2 — invalidate persons-list cache for this workspace (cross-instance).
  void cacheInvalidate(`ws:${workspaceId}:persons`);

  return NextResponse.json({
    person: {
      ...person,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
    },
  }, { status: 201 });
}
