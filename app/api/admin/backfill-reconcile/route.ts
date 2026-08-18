// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 8. Library-wide date reconcile control surface.
//
//   GET  — dry-run manifest: how many proposals fall in each gate band + a
//          content hash over the auto-commit set. Read-only.
//   POST — { apply:true, batchSize?, maxRows? } enqueues the one-off reconcile
//          job that commits the auto-commit band (gated mass write). Without
//          apply:true it just returns the manifest. The job is keyed by the
//          manifest content hash so a double-submit dedups.
//
// Authz: workspace owner only.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { buildDateBackfillManifest } from "@/lib/reconcile/dateBackfill";
import { addBackfillReconcileJob } from "@/lib/queue/queues";

async function ownerWorkspace(userId: string) {
  const workspace = await ensurePersonalWorkspace(userId);
  if (!workspace) return null;
  const authz = await requireWorkspaceOwner(workspace.id);
  return authz.ok ? workspace : null;
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await ownerWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const manifest = await buildDateBackfillManifest(workspace.id);
  return NextResponse.json({ manifest });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await ownerWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    apply?: unknown;
    batchSize?: unknown;
    maxRows?: unknown;
  };

  const manifest = await buildDateBackfillManifest(workspace.id);

  // Dry-run unless the caller explicitly opts into the mass write.
  if (body.apply !== true) {
    return NextResponse.json({ manifest, enqueued: false });
  }

  // Clamp to sane ranges: a bare `typeof === "number"` lets -1, 0, Infinity, and
  // NaN through into the worker payload. Non-finite/absent → undefined (use the
  // job's own defaults).
  const clampInt = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.max(min, Math.min(max, Math.trunc(v)))
      : undefined;
  const batchSize = clampInt(body.batchSize, 1, 5000);
  const maxRows = clampInt(body.maxRows, 1, 10_000_000);

  // Key the job to this exact auto-commit set so a double-submit is a no-op
  // while one is in flight.
  const jobId = await addBackfillReconcileJob(
    { workspaceId: workspace.id, batchSize, maxRows },
    { jobId: `reconcile:${workspace.id}:${manifest.contentHash.slice(0, 16)}` }
  );

  return NextResponse.json({ manifest, enqueued: true, jobId });
}
