// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Review-at-scale (M15.1 / ADR 0012) — reason-bucketed date review queue.
// Returns the queue grouped by (conflict × dominant evidence source) with a
// small sample per bucket, so the UI can offer trust-ramp bulk decisions
// instead of a flat 80k-item list. Owner-gated, read-only.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { listDateBuckets, getSortingProgress, type BucketAxis } from "@/lib/reconcile/bucketReview";

const AXES = new Set<BucketAxis>(["source", "folder", "time"]);

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // M15.4 / ADR 0059 — group along one axis (source default = shipped path).
  const ax = request.nextUrl.searchParams.get("axis") as BucketAxis | null;
  const axis: BucketAxis = ax && AXES.has(ax) ? ax : "source";

  const [{ buckets, totalReview }, progress] = await Promise.all([
    listDateBuckets(workspace.id, axis),
    getSortingProgress(workspace.id),
  ]);
  return NextResponse.json({ workspaceId: workspace.id, axis, buckets, totalReview, progress });
}
