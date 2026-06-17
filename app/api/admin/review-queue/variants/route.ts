// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. LAZY + PAGED variant lane for the Tidy Up
// review screen. The SSIM-heavy manifest build (download R2 previews + Stage-2
// structural compare per member) is the ~50s tail that used to block the whole
// page; it now lives here, behind a chip the operator opts into, and is fetched
// in small batches (limit/offset) instead of all 30 candidate groups at once.
//
// Each returned group mirrors the shape the client already consumes from the
// retired inline lane: groupId, canonicalAssetId, canonicalScore, confidence,
// decision, trashCandidates[{assetId,ssim}], keptDistinct[]. Owner-only.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { buildGroupManifest } from "@/lib/variants/consolidate";

const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 6;

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Number(searchParams.get("limit")) || DEFAULT_LIMIT)
  );
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);

  // Stable ordering so paging is deterministic across requests. We pull one
  // extra id past the window to cheaply learn whether more candidates exist
  // without a second COUNT round-trip.
  const ids = await db
    .select({ id: schema.variantGroups.id })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspace.id),
        eq(schema.variantGroups.status, "candidate")
      )
    )
    .orderBy(asc(schema.variantGroups.createdAt), asc(schema.variantGroups.id))
    .offset(offset)
    .limit(limit + 1);

  const hasMore = ids.length > limit;
  const pageIds = ids.slice(0, limit);

  const groups: {
    groupId: string;
    canonicalAssetId: string;
    canonicalScore: number;
    confidence: number;
    decision: "auto-commit" | "review" | "leave";
    trashCandidates: { assetId: string; ssim: number }[];
    keptDistinct: string[];
  }[] = [];

  for (const { id } of pageIds) {
    const m = await buildGroupManifest(id);
    if (!m) continue;
    if (m.decision === "leave" || m.trashCandidates.length === 0) continue;
    groups.push({
      groupId: m.groupId,
      canonicalAssetId: m.canonicalAssetId,
      canonicalScore: Number(m.canonicalMetrics.score.toFixed(3)),
      confidence: Number(m.confidence.toFixed(3)),
      decision: m.decision,
      trashCandidates: m.trashCandidates.map((c) => ({
        assetId: c.assetId,
        ssim: Number((c.ssimToCanonical ?? 0).toFixed(3)),
      })),
      keptDistinct: m.keptDistinct.map((c) => c.assetId),
    });
  }

  return NextResponse.json({ groups, offset, limit, hasMore });
}
