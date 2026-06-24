// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Review-at-scale (M15.2) — reverse the most recent bulk action on a date
// bucket (the UI "Undo" snackbar). Restores each row's prior status +
// captured_at from its undo snapshot. Server-resolved + owner-gated; enqueues
// the reconcile worker with bucket.undo=true.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { addBackfillReconcileJob } from "@/lib/queue/queues";
import { resolveBucketKey } from "@/lib/reconcile/bucketKeyRoute";

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const bucketKey = resolveBucketKey(body);
  if (!bucketKey) {
    return NextResponse.json({ error: "bucketKey (or evidenceSource+conflict) required" }, { status: 400 });
  }

  const key = `bucketundo:${workspace.id}:${bucketKey}`;
  const jobId = await addBackfillReconcileJob(
    {
      workspaceId: workspace.id,
      // action is ignored when undo=true (worker branches on undo first).
      bucket: { bucketKey, action: "confirm", undo: true },
    },
    { jobId: key }
  );

  return NextResponse.json({ enqueued: true, jobId });
}
