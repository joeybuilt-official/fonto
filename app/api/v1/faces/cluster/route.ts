// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — POST /api/v1/faces/cluster
//
// Owner-only. Runs `clusterWorkspaceFaces` synchronously over the caller's
// primary workspace and returns the create/update/noise counts so the UI
// can render a quick toast ("3 new people, 12 faces clustered").
//
// At workspace-archive scale (≤ ~100k faces) the in-memory DBSCAN runs in
// seconds; large multi-tenant deploys should swap this for an enqueued
// BullMQ job. Until then the owner-only gate is the rate limit.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { clusterWorkspaceFaces } from "@/lib/faces/cluster";

interface PostBody {
  eps?: unknown;
  minPts?: unknown;
  min_pts?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspace = workspaces[0];

  // Clustering is destructive (rewrites person_id on every face). Owner-only.
  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    workspace.id,
    "owner"
  );
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as PostBody;
  const opts: { eps?: number; minPts?: number } = {};
  if (typeof body.eps === "number" && Number.isFinite(body.eps) && body.eps > 0 && body.eps < 2) {
    opts.eps = body.eps;
  }
  const minPtsRaw = body.minPts ?? body.min_pts;
  if (typeof minPtsRaw === "number" && Number.isFinite(minPtsRaw) && minPtsRaw >= 2) {
    opts.minPts = Math.floor(minPtsRaw);
  }

  const stats = await clusterWorkspaceFaces(workspace.id, opts);
  return NextResponse.json({ stats });
}
