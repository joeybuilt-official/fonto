// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 0.2 — periodic reaper for assets stuck in a non-terminal
// processing_state ('captured' / 'classified' / 'extracted').
//
// Why this exists: BullMQ's own `attempts: 5` policy retries jobs whose
// handlers throw, but it cannot recover from a worker that crashed (SIGKILL,
// OOM, container drift) *after* setting the asset row to 'processing' and
// *before* setting it to 'ready' or 'failed'. The job may already be gone
// from Redis (e.g. the worker checkpointed it as active but the process
// vanished) while the DB row remains stuck forever. This sweep is the
// belt-and-braces fix.
//
// Algorithm:
//   1. Scan fonto.assets WHERE processing_state IN
//        ('captured','classified','extracted')
//        AND updated_at < NOW() - INTERVAL '<threshold> minutes'.
//   2. For each row:
//        - if processing_attempts < 5 → re-enqueue on assetProcessingQueue
//          with the original payload reconstructed from the row + workspace
//          owner. Do NOT reset processing_state — the worker will set it to
//          'ready' or 'failed' on its next run.
//        - if processing_attempts >= 5 → terminally fail: write
//          processing_state='failed' + processing_error='reaped ...'. Do not
//          re-enqueue.
//   3. Emit structured pino lines tagged event=reaper.scan / .reenqueue /
//      .exhausted so the metrics layer can chart sweep activity.
//
// Idempotency: running back-to-back is safe. The threshold ensures a row
// recently touched by either a re-enqueue or the worker will not match on the
// next tick. The terminal-failure branch sets processing_state='failed', which
// also drops the row out of the scan predicate.

import { and, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { assetProcessingQueue, thumbnailQueue } from "@/lib/queue/queues";
import { JobNames, type ProcessAssetJob } from "@/lib/queue/jobs";

export const REAPER_MAX_ATTEMPTS = 5;

/**
 * Configurable threshold (minutes) after which a row in `processing` state is
 * considered stuck. A worker that died mid-job will leave the row in this
 * state forever otherwise. Defaults to 60 minutes — generous enough that a
 * legitimately slow processAsset run (image decoding + Plexo classification +
 * OCR) is well clear of it.
 */
export function getStuckThresholdMinutes(): number {
  const raw = process.env.REAPER_STUCK_THRESHOLD_MINUTES;
  if (!raw) return 60;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return n;
}

/**
 * Bound on the thumbnail-backfill sweep so one tick can't fan tens of
 * thousands of GenerateThumbnails jobs onto the queue at once. Rows not picked
 * up this tick stay eligible (they still match the predicate) and drain over
 * subsequent sweeps.
 */
export function getThumbnailBackfillBatch(): number {
  const raw = process.env.REAPER_THUMBNAIL_BACKFILL_BATCH;
  if (!raw) return 200;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return n;
}

export interface ReapResult {
  candidates: number;
  reenqueued: number;
  exhausted: number;
  /** Ready rows missing a thumbnail that had GenerateThumbnails re-enqueued. */
  thumbnailBackfilled: number;
}

/**
 * One sweep. Returns counts so the caller (the BullMQ handler) can include
 * them in its completion log or surface them to metrics later.
 */
export async function reapStuckAssets(): Promise<ReapResult> {
  const thresholdMinutes = getStuckThresholdMinutes();
  const log = logger.child({ component: "reaper", thresholdMinutes });

  // Drizzle does not have a portable `INTERVAL` helper across dialects, so use
  // a tagged SQL fragment. Postgres-specific by design — fonto is Postgres-only.
  const cutoff = sql`now() - (${thresholdMinutes}::int * interval '1 minute')`;

  const stuck = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      extractedText: schema.assets.extractedText,
      processingAttempts: schema.assets.processingAttempts,
      thumbnailKey: schema.assets.thumbnailKey,
      updatedAt: schema.assets.updatedAt,
    })
    .from(schema.assets)
    .where(
      and(
        // The pipeline never writes a literal 'processing' state — rows move
        // captured -> classified -> extracted -> ready, or -> failed. A row
        // sitting in any non-terminal state past the threshold is stuck (the
        // worker died mid-job, or a failure reset it to 'captured'). Terminal
        // states 'ready'/'failed' are excluded, so reaped rows drop out.
        inArray(schema.assets.processingState, [
          "captured",
          "classified",
          "extracted",
        ]),
        lt(schema.assets.updatedAt, cutoff)
      )
    );

  log.info({ event: "reaper.scan", candidates: stuck.length }, "reaper scan");

  if (stuck.length === 0) {
    // No stuck rows, but ready-but-thumbnailless rows can still exist (a
    // thumbnail job that never landed on a row the pipeline already marked
    // 'ready'). Run that independent sweep before returning.
    const thumbnailBackfilled = await backfillReadyThumbnails();
    return { candidates: 0, reenqueued: 0, exhausted: 0, thumbnailBackfilled };
  }

  // Resolve workspace -> user mapping in a single batch query rather than
  // per-row. Most stuck rows in practice will share workspaces.
  const workspaceIds = Array.from(new Set(stuck.map((r) => r.workspaceId)));
  const workspaces = workspaceIds.length
    ? await db
        .select({ id: schema.workspaces.id, userId: schema.workspaces.userId })
        .from(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaceIds))
    : [];
  const workspaceUser = new Map(workspaces.map((w) => [w.id, w.userId]));

  let reenqueued = 0;
  let exhausted = 0;

  for (const row of stuck) {
    if (row.processingAttempts >= REAPER_MAX_ATTEMPTS) {
      // Terminal failure. The row is dropped out of the candidate set on
      // future sweeps by the processing_state filter.
      await db
        .update(schema.assets)
        .set({
          processingState: "failed",
          processingError: `reaped after ${REAPER_MAX_ATTEMPTS} attempts stuck >1h`,
        })
        .where(eq(schema.assets.id, row.id));
      log.warn(
        {
          event: "reaper.exhausted",
          assetId: row.id,
          attempts: row.processingAttempts,
        },
        "asset exhausted retries — marking failed"
      );
      exhausted += 1;
      continue;
    }

    const userId = workspaceUser.get(row.workspaceId);
    if (!userId) {
      // Workspace vanished — nothing sensible we can do beyond marking the
      // row as failed. Treat as exhausted-equivalent so it doesn't loop.
      await db
        .update(schema.assets)
        .set({
          processingState: "failed",
          processingError: "reaped: owning workspace not found",
        })
        .where(eq(schema.assets.id, row.id));
      log.warn(
        { event: "reaper.exhausted", assetId: row.id, reason: "no-workspace" },
        "asset stuck and workspace missing — marking failed"
      );
      exhausted += 1;
      continue;
    }

    const payload: ProcessAssetJob = {
      assetId: row.id,
      workspaceId: row.workspaceId,
      userId,
      filename: row.filename,
      mimeType: row.mimeType,
      extractedText: row.extractedText,
    };

    try {
      await assetProcessingQueue().add(JobNames.ProcessAsset, payload);
      // Phase 1.1 — if the row never got its derivatives generated (e.g. the
      // worker died before the thumbnail job landed, or the thumbnail queue
      // was empty when the row was first enqueued), re-fan that job out now.
      // Cheap to re-run; non-image rows are guarded the same way the
      // producer does it.
      if (
        row.thumbnailKey == null &&
        (row.mimeType.startsWith("image/") ||
          row.mimeType.startsWith("video/") ||
          row.mimeType === "application/pdf")
      ) {
        try {
          await thumbnailQueue().add(JobNames.GenerateThumbnails, {
            assetId: row.id,
            workspaceId: row.workspaceId,
          });
        } catch (err) {
          log.warn(
            {
              event: "reaper.thumb_enqueue_failed",
              assetId: row.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "thumbnail re-enqueue failed"
          );
        }
      }
      log.info(
        {
          event: "reaper.reenqueue",
          assetId: row.id,
          attempts: row.processingAttempts,
        },
        "stuck asset re-enqueued"
      );
      reenqueued += 1;
    } catch (err) {
      // Don't let a single bad enqueue stop the sweep — record and move on.
      // The next tick will retry.
      log.error(
        {
          event: "reaper.reenqueue_failed",
          assetId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to re-enqueue stuck asset"
      );
    }
  }

  const thumbnailBackfilled = await backfillReadyThumbnails();

  return { candidates: stuck.length, reenqueued, exhausted, thumbnailBackfilled };
}

/**
 * Phase 1.1 follow-up — bounded sweep for rows the pipeline already finished
 * (processing_state='ready') that never got a thumbnail. The existing stuck
 * sweep above only re-fans thumbnails for rows still in a NON-terminal state;
 * a row that reached 'ready' with thumbnail_key IS NULL (e.g. the thumbnail
 * job was dropped, or GenerateThumbnails failed silently) would otherwise never
 * self-heal. This re-enqueues GenerateThumbnails for image/video/pdf rows whose
 * thumbnail is missing and whose row has been settled longer than the same
 * stuck threshold. Bounded by getThumbnailBackfillBatch(); leftovers drain on
 * later ticks. Independent of the stuck-asset logic above.
 */
async function backfillReadyThumbnails(): Promise<number> {
  const thresholdMinutes = getStuckThresholdMinutes();
  const log = logger.child({ component: "reaper", thresholdMinutes });
  const cutoff = sql`now() - (${thresholdMinutes}::int * interval '1 minute')`;
  const batch = getThumbnailBackfillBatch();

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.processingState, "ready"),
        isNull(schema.assets.thumbnailKey),
        lt(schema.assets.updatedAt, cutoff),
        or(
          like(schema.assets.mimeType, "image/%"),
          like(schema.assets.mimeType, "video/%"),
          eq(schema.assets.mimeType, "application/pdf")
        )!
      )
    )
    .limit(batch);

  log.info(
    { event: "reaper.thumbnail_backfill_scan", candidates: rows.length },
    "reaper thumbnail-backfill scan"
  );

  let backfilled = 0;
  for (const row of rows) {
    try {
      await thumbnailQueue().add(JobNames.GenerateThumbnails, {
        assetId: row.id,
        workspaceId: row.workspaceId,
      });
      log.info(
        { event: "reaper.thumbnail_backfill", assetId: row.id },
        "ready asset missing thumbnail — re-enqueued GenerateThumbnails"
      );
      backfilled += 1;
    } catch (err) {
      log.warn(
        {
          event: "reaper.thumbnail_backfill_failed",
          assetId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "thumbnail backfill re-enqueue failed"
      );
    }
  }

  return backfilled;
}
