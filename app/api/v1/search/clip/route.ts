// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.2 — text-to-image CLIP search endpoint.
//
//   GET  /api/v1/search/clip?q=dog+on+beach&limit=50
//   POST /api/v1/search/clip   { q, limit, workspaceId? }
//
// Embeds the query text via the vision sidecar, runs a pgvector
// nearest-neighbour search against `assets.clip_vec`, and returns the
// matching assets sorted by cosine similarity descending.
//
// Graceful degradation:
//   - If the vision service isn't configured, returns `{ results: [],
//     unavailable: true, reason: "vision service not configured" }`.
//   - If the vision service throws or the column isn't migrated (4.3 pending),
//     returns `{ results: [], unavailable: true, reason: "..." }` rather than
//     a 500 — keeps the UI quiet during phased rollouts.
//
// Authz: gated on `requireWorkspaceAccess(userId, workspaceId, 'viewer')`.
// The workspace is resolved from `?workspaceId=` if provided, otherwise the
// caller's first workspace (matching the existing /api/v1/search behaviour).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, and, isNull } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccess } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { intelligence } from "@/lib/intelligence/client";
import { nearestNeighbors } from "@/lib/vectors";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { parseScopeParam, scopeCond } from "@/lib/scope";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SIMILARITY_THRESHOLD = 0.2;

interface ClipSearchInput {
  q: string;
  limit: number;
  workspaceId: string | null;
}

function clampLimit(raw: number | null | undefined): number {
  if (!raw || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(raw));
}

async function readInput(req: NextRequest): Promise<ClipSearchInput | NextResponse> {
  if (req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const q = typeof body.q === "string" ? body.q.trim() : "";
    const limit = clampLimit(typeof body.limit === "number" ? body.limit : null);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : null;
    return { q, limit, workspaceId };
  }
  const sp = req.nextUrl.searchParams;
  return {
    q: (sp.get("q") ?? "").trim(),
    limit: clampLimit(Number(sp.get("limit"))),
    workspaceId: sp.get("workspaceId"),
  };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const input = await readInput(request);
  if (input instanceof NextResponse) return input;
  const { q, limit } = input;

  if (!q) {
    return NextResponse.json(
      { error: "Missing required query 'q'" },
      { status: 400 }
    );
  }

  // Short-circuit when the vision service isn't configured. This is the
  // common "running fonto without the optional vision sidecar" case.
  if (!intelligence.available("embedText")) {
    return NextResponse.json({
      results: [],
      unavailable: true,
      reason: "vision service not configured",
    });
  }

  // Resolve workspace. Prefer explicit ?workspaceId=; otherwise pick the
  // caller's first accessible workspace (matches /api/v1/search default).
  let workspaceId = input.workspaceId;
  if (!workspaceId) {
    const workspaces = await getUserWorkspaces(user.id);
    if (!workspaces.length) {
      return NextResponse.json({ results: [] });
    }
    workspaceId = workspaces[0].id;
  } else {
    try {
      await requireWorkspaceAccess(user.id, workspaceId, "viewer");
    } catch {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 }
      );
    }
  }

  // Embed the query. Vision failures degrade to "unavailable" instead of 500.
  let queryVec: number[];
  try {
    const embedded = await intelligence.embedText(q);
    queryVec = [...embedded.vector];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      results: [],
      unavailable: true,
      reason: `vision embed failed: ${msg.slice(0, 200)}`,
    });
  }

  // ADR 0008 — scope default (no scope param on POST body ⇒ PERSONAL)
  const __scope = parseScopeParam(request.nextUrl.searchParams);
  const __sc = scopeCond(__scope);
  const hits = await nearestNeighbors(workspaceId, queryVec, limit, SIMILARITY_THRESHOLD, __scope);
  if (!hits.length) {
    return NextResponse.json({ results: [] });
  }

  const ids = hits.map((h) => h.assetId);
  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        inArray(schema.assets.id, ids),
        isNull(schema.assets.deletedAt),
        __sc
      )
    );

  // Preserve hit ordering (pgvector gave us best-match-first); join row data
  // back in by id and drop any hit whose row was filtered out (deleted etc).
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results: Array<{ asset: ReturnType<typeof serializeAsset>; similarity: number }> = [];
  for (const h of hits) {
    const row = byId.get(h.assetId);
    if (!row) continue;
    results.push({ asset: serializeAsset(row), similarity: h.similarity });
  }

  return NextResponse.json({ results });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
