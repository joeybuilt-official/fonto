// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Review-at-scale (M15.1 / ADR 0012) — apply a reversible action to an entire
// reason-bucket of the date review band. The set is resolved SERVER-SIDE (the
// client never enumerates tens of thousands of ids): we enqueue the resumable
// reconcile worker with a `bucket` payload. Owner-gated.
//
// Reversible actions only (confirm/reject/quarantine — all status transitions
// that keep the inference row + mapEstimate). PURGE is never on this path.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { addBackfillReconcileJob } from "@/lib/queue/queues";

const ACTIONS = new Set(["confirm", "reject", "quarantine"]);

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    evidenceSource?: unknown;
    conflict?: unknown;
    action?: unknown;
  };

  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  if (typeof body.conflict !== "boolean") {
    return NextResponse.json({ error: "conflict (boolean) required" }, { status: 400 });
  }
  // null = the "Other evidence" bucket (no dominant source); otherwise a string.
  const evidenceSource =
    body.evidenceSource === null
      ? null
      : typeof body.evidenceSource === "string"
        ? body.evidenceSource
        : undefined;
  if (evidenceSource === undefined) {
    return NextResponse.json({ error: "evidenceSource (string|null) required" }, { status: 400 });
  }

  // Dedup a double-submit of the same bucket+action while one is in flight.
  const key = `bucket:${workspace.id}:${body.conflict ? "c" : "n"}:${evidenceSource ?? "null"}:${action}`;
  const jobId = await addBackfillReconcileJob(
    {
      workspaceId: workspace.id,
      bucket: { evidenceSource, conflict: body.conflict, action: action as "confirm" | "reject" | "quarantine" },
    },
    { jobId: key }
  );

  return NextResponse.json({ enqueued: true, jobId });
}
