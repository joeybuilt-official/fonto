// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5. Read-only DRY-RUN of variant consolidation: for
// each candidate variant group in the caller's workspace, build the manifest
// (canonical pick + Stage-2 SSIM verify + destructive-gate decision) WITHOUT
// writing anything. This is the manifest-first surface the operator reviews
// before any trash/purge, and the data source the Phase 6 review queue will use.
//
// Authed via better-auth (same as the other /api/admin routes); only the user's
// own workspaces are reachable.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { buildWorkspaceManifests } from "@/lib/variants/consolidate";

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspaces" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const requested = searchParams.get("workspaceId");
  const allIds = workspaces.map((w) => w.id);
  const workspaceId = requested && allIds.includes(requested) ? requested : allIds[0];
  const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 25));

  const manifests = await buildWorkspaceManifests(workspaceId, limit);

  const totals = manifests.reduce(
    (acc, m) => {
      acc.trashCandidates += m.trashCandidates.length;
      acc.keptDistinct += m.keptDistinct.length;
      acc.decisions[m.decision] = (acc.decisions[m.decision] ?? 0) + 1;
      return acc;
    },
    { groups: manifests.length, trashCandidates: 0, keptDistinct: 0, decisions: {} as Record<string, number> }
  );

  return NextResponse.json({
    workspaceId,
    limit,
    totals,
    groups: manifests.map((m) => ({
      groupId: m.groupId,
      canonicalAssetId: m.canonicalAssetId,
      canonicalScore: Number(m.canonicalMetrics.score.toFixed(3)),
      trashCandidates: m.trashCandidates.map((c) => ({
        assetId: c.assetId,
        ssim: Number((c.ssimToCanonical ?? 0).toFixed(3)),
        score: Number(c.score.toFixed(3)),
      })),
      keptDistinct: m.keptDistinct.map((c) => ({
        assetId: c.assetId,
        ssim: Number((c.ssimToCanonical ?? 0).toFixed(3)),
      })),
      confidence: Number(m.confidence.toFixed(3)),
      decision: m.decision,
      skippedNoPreview: m.skippedNoPreview.length,
    })),
  });
}
