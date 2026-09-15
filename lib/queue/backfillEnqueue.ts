// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M5d — queue enqueue helpers for the worker-side backfill sweeps
// (lib/processing/reprocessBackfill.ts). Each reclaims the retained TERMINAL
// job for an asset id before re-adding, because BullMQ refuses an `add` whose
// jobId exists in ANY set — including `completed`/`failed` — and an
// unreclaimed id makes the re-enqueue a silent no-op (the trap fixed in
// scripts/backfill-thumbnails.ts on 2026-09-01). `queue.remove` returns 0 and
// does NOT throw for a job that is absent or ACTIVE, so in-flight work is
// never yanked and a fresh id costs nothing extra.

import { thumbnailQueue, clipEmbeddingQueue } from "@/lib/queue/queues";

export interface EnqueueTarget {
  assetId: string;
  workspaceId: string;
}

/**
 * Reclaim + re-add `generate-thumbnails` jobs. Returns count of retained
 * terminal jobs actually removed (0 when all were fresh/active).
 */
export async function enqueueThumbnail(rows: EnqueueTarget[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = thumbnailQueue();
  const results = await Promise.allSettled(
    rows.map((r) => q.remove(`backfill-thumb-${r.assetId}`))
  );
  const reclaimed = results.filter(
    (o) => o.status === "fulfilled" && o.value === 1
  ).length;
  await q.addBulk(
    rows.map((r) => ({
      name: "generate-thumbnails",
      data: { assetId: r.assetId, workspaceId: r.workspaceId },
      opts: { jobId: `backfill-thumb-${r.assetId}` },
    }))
  );
  return reclaimed;
}

/**
 * Reclaim + re-add `embed-asset` jobs (CLIP). Returns count reclaimed.
 */
export async function enqueueClipEmbed(rows: EnqueueTarget[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = clipEmbeddingQueue();
  const results = await Promise.allSettled(
    rows.map((r) => q.remove(`backfill-clip-${r.assetId}`))
  );
  const reclaimed = results.filter(
    (o) => o.status === "fulfilled" && o.value === 1
  ).length;
  await q.addBulk(
    rows.map((r) => ({
      name: "embed-asset",
      data: { assetId: r.assetId, workspaceId: r.workspaceId },
      opts: { jobId: `backfill-clip-${r.assetId}` },
    }))
  );
  return reclaimed;
}