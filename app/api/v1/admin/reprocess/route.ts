// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M5d — owner-gated on-demand trigger for the recurring maintenance backfills.
// Pairs with /admin/reprocess (the web surface). The route enqueues one
// maintenance-queue job per request from a fixed whitelist; the WORKER does
// the actual repair work (same dispatch targets the schedulers use), so this
// route adds no duplicated predicate.
//
//   POST /api/v1/admin/reprocess
//     Body: { job: "thumbnails" | "clip" | "auto-cluster" | "evidence" |
//                 "inference" | "face-crops" | "reap-stuck" }   (required)
//     Returns { enqueued: <job name> } or 400 for an unknown job.
//
// Instance-admin only (M14 / ADR 0055 tier — env allowlist, fail-closed).
//
// The allowed set deliberately mirrors JobNames that have worker-side
// handlers. "thumbnails"/"clip" are the M5d additions (worker-side versions
// of the backfill:* scripts); the rest were already dispatchable.
import { NextRequest, NextResponse } from "next/server";
import { requireInstanceAdmin } from "@/lib/authz/instance";
import { JobNames, type JobName } from "@/lib/queue/jobs";
import { maintenanceQueue } from "@/lib/queue/queues";
import { enqueueBackfillFaceCrops } from "@/lib/processing/backfillFaceCrops";

type ReprocessJob =
  | "thumbnails"
  | "clip"
  | "auto-cluster"
  | "evidence"
  | "inference"
  | "face-crops"
  | "reap-stuck";

const ALLOWED: readonly ReprocessJob[] = [
  "thumbnails",
  "clip",
  "auto-cluster",
  "evidence",
  "inference",
  "face-crops",
  "reap-stuck",
];

async function enqueue(job: ReprocessJob): Promise<JobName> {
  switch (job) {
    case "thumbnails":
      await maintenanceQueue().add(JobNames.BackfillThumbnails, {});
      return JobNames.BackfillThumbnails;
    case "clip":
      await maintenanceQueue().add(JobNames.BackfillClip, {});
      return JobNames.BackfillClip;
    case "auto-cluster":
      // Fan out to every workspace with face data (worker-side enumeration —
      // mirrors the old /cron/auto-cluster route, now one maintenance job).
      await maintenanceQueue().add(JobNames.AutoClusterScan, {});
      return JobNames.AutoClusterScan;
    case "evidence":
      await maintenanceQueue().add(JobNames.BackfillEvidence, {});
      return JobNames.BackfillEvidence;
    case "inference":
      await maintenanceQueue().add(JobNames.BackfillInference, {});
      return JobNames.BackfillInference;
    case "face-crops":
      await enqueueBackfillFaceCrops();
      return JobNames.BackfillFaceCrops;
    case "reap-stuck":
      await maintenanceQueue().add(JobNames.ReapStuckAssets, {});
      return JobNames.ReapStuckAssets;
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { job?: unknown } | null;
  const job = typeof body?.job === "string" ? (body.job as ReprocessJob) : null;
  if (!job || !(ALLOWED as readonly string[]).includes(job)) {
    return NextResponse.json(
      { error: `Unknown maintenance job. Allowed: ${ALLOWED.join(", ")}` },
      { status: 400 }
    );
  }

  const name = await enqueue(job);
  return NextResponse.json({ enqueued: name });
}