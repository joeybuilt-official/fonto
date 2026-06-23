// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Review-at-scale (M15.1 / ADR 0012) — reason-bucketed date review queue.
// Returns the queue grouped by (conflict × dominant evidence source) with a
// small sample per bucket, so the UI can offer trust-ramp bulk decisions
// instead of a flat 80k-item list. Owner-gated, read-only.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { listDateBuckets } from "@/lib/reconcile/bucketReview";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { buckets, totalReview } = await listDateBuckets(workspace.id);
  return NextResponse.json({ workspaceId: workspace.id, buckets, totalReview });
}
