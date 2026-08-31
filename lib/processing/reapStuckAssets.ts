// SPDX-License-Identifier: MIT
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
//        AND updated_at < NOW() - INTERVAL '<threshold> minutes',
//        oldest-first and capped at REAPER_STUCK_BATCH rows per tick.
//   2. For each row:
//        - if processing_attempts < 5 → re-enqueue on assetProcessingQueue
//          with the original payload reconstructed from the row + workspace
//          owner, under a pinned jobId so repeat sweeps collapse onto the one
//          job instead of fanning out a duplicate per tick. Do NOT reset
//          processing_state — the worker will set it to 'ready' or 'failed'
//          on its next run. Bump updated_at + processing_attempts on the way
//          out: updated_at is what the scan orders and filters on (without it
//          the capped scan re-picks the same head rows forever), and
//          processing_attempts is otherwise only incremented by the worker on
//          dequeue — a row buried deep in the queue never dequeues, so its
//          budget below would never be spent.
//        - if processing_attempts >= 5 → settle, without re-enqueueing. A row
//          that already carries a thumbnail AND a CLIP vector is findable and
//          viewable; only the generative tail (VLM description +
//          classification) is outstanding, and that stage is slow enough to
//          blow the stuck threshold on its own. Calling it 'failed' is a lie
//          the UI then asks the user to retry — and the retry re-runs the same
//          stalled stage. Those rows get processing_state='ready' +
//          processing_error=NULL, and the enrichment is left to a later
//          backfill. Every other exhausted row terminally fails: write
//          processing_state='failed' + processing_error='reaped ...'.
//   3. Emit structured pino lines tagged event=reaper.scan / .reenqueue /
//      .settled / .exhausted so the metrics layer can chart sweep activity.
//
// Idempotency: running back-to-back is safe. The threshold ensures a row
// recently touched by either a re-enqueue or the worker will not match on the
// next tick. The settle branches write processing_state='ready' or 'failed',
// both of which drop the row out of the scan predicate.
//
// A second, independent sweep covers sync_state: the legacy multipart upload
// route inserts the row, flips sync_state to 'syncing', then does the R2 PUT.
// A process death mid-PUT (OOM on a multi-GB video) strands the row at
// 'syncing' forever — nothing else watches that column. See
// reapStrandedSyncing() below.

import { and, asc, eq, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
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
 * Bound on the primary stuck sweep. Unbounded, this one select fanned every
 * non-terminal row onto the queue every tick — the amplifier that turned ~6.6k
 * genuinely unprocessed assets into a ~497k queue. Rows not picked up this tick
 * stay eligible and drain over subsequent sweeps, oldest-first.
 */
export function getStuckBatch(): number {
  const raw = process.env.REAPER_STUCK_BATCH;
  if (!raw) return 200;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
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

/**
 * Configurable threshold (minutes) after which a row still in
 * sync_state='syncing' is considered stranded by a dead uploader process.
 * Defaults to 60 minutes — comfortably past the slowest legitimate multi-GB
 * multipart PUT, so a still-running upload is never reaped out from under
 * itself.
 */
export function getSyncStrandedThresholdMinutes(): number {
  const raw = process.env.REAPER_SYNC_STRANDED_THRESHOLD_MINUTES;
  if (!raw) return 60;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return n;
}

/**
 * Bound on the stranded-sync sweep so one tick can't rewrite an unbounded
 * number of rows. Leftovers still match the predicate and drain on later ticks.
 */
export function getSyncStrandedBatch(): number {
  const raw = process.env.REAPER_SYNC_STRANDED_BATCH;
  if (!raw) return 200;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return n;
}

export interface ReapResult {
  candidates: number;
  reenqueued: number;
  exhausted: number;
  /**
   * Rows that exhausted their retries but already had a thumbnail and a CLIP
   * vector, so they were settled as 'ready' rather than 'failed' — viewable
   * and searchable, with only the generative tail outstanding.
   */
  settledWithoutEnrichment: number;
  /** Ready rows missing a thumbnail that had GenerateThumbnails re-enqueued. */
  thumbnailBackfilled: number;
  /** Rows stranded in sync_state='syncing' that were moved to 'error'. */
  syncStranded: number;
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
  const batch = getStuckBatch();

  const stuck = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      extractedText: schema.assets.extractedText,
      processingAttempts: schema.assets.processingAttempts,
      thumbnailKey: schema.assets.thumbnailKey,
      thumbnailState: schema.assets.thumbnailState,
      // Presence only. Never pull the 512-dim vector itself into the sweep's
      // working set — the batch is up to REAPER_STUCK_BATCH rows wide.
      hasClipVec: sql<boolean>`${schema.assets.clipVec} IS NOT NULL`,
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
    )
    // Oldest-first + capped: the sweep is a cursor over the backlog, not a
    // full-table fan-out. The re-enqueue below bumps updated_at, which is what
    // moves the cursor forward on the next tick.
    .orderBy(asc(schema.assets.updatedAt))
    .limit(batch);

  log.info({ event: "reaper.scan", candidates: stuck.length }, "reaper scan");

  if (stuck.length === 0) {
    // No stuck rows, but ready-but-thumbnailless rows can still exist (a
    // thumbnail job that never landed on a row the pipeline already marked
    // 'ready'). Run those independent sweeps before returning.
    const thumbnailBackfilled = await backfillReadyThumbnails();
    const syncStranded = await reapStrandedSyncing();
    return {
      candidates: 0,
      reenqueued: 0,
      exhausted: 0,
      settledWithoutEnrichment: 0,
      thumbnailBackfilled,
      syncStranded,
    };
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
  let settledWithoutEnrichment = 0;

  for (const row of stuck) {
    if (row.processingAttempts >= REAPER_MAX_ATTEMPTS) {
      if (row.thumbnailKey && row.hasClipVec) {
        // Cheap stages already landed: the asset renders in the grid and
        // answers semantic search. Only the generative tail is missing, so
        // this is not a failure — settle it as 'ready' with no error, and
        // leave the description/classification to a later backfill. Marking
        // it 'failed' would put it behind a retry that re-runs the whole
        // chain and stalls at the same stage.
        await db
          .update(schema.assets)
          .set({ processingState: "ready", processingError: null })
          .where(eq(schema.assets.id, row.id));
        log.info(
          {
            event: "reaper.settled",
            assetId: row.id,
            attempts: row.processingAttempts,
          },
          "asset exhausted retries but is viewable — settling as ready"
        );
        settledWithoutEnrichment += 1;
        continue;
      }

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
      await assetProcessingQueue().add(JobNames.ProcessAsset, payload, {
        jobId: `reap-${row.id}`,
      });
      // Advance the cursor and spend one unit of the retry budget. Both writes
      // are what make the REAPER_MAX_ATTEMPTS branch above reachable at all.
      await db
        .update(schema.assets)
        .set({
          processingAttempts: sql`${schema.assets.processingAttempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.assets.id, row.id));
      // Phase 1.1 — if the row never got its derivatives generated (e.g. the
      // worker died before the thumbnail job landed, or the thumbnail queue
      // was empty when the row was first enqueued), re-fan that job out now.
      // Cheap to re-run; non-image rows are guarded the same way the
      // producer does it.
      // 'skipped' is a decision, not a gap: either a non-renderable mime or an
      // original over the size ceiling. Re-driving it re-runs the same skip
      // every tick and, for the oversized case, used to re-wedge a worker slot.
      if (
        row.thumbnailKey == null &&
        row.thumbnailState !== "skipped" &&
        (row.mimeType.startsWith("image/") ||
          row.mimeType.startsWith("video/") ||
          row.mimeType === "application/pdf")
      ) {
        try {
          await thumbnailQueue().add(
            JobNames.GenerateThumbnails,
            { assetId: row.id, workspaceId: row.workspaceId },
            { jobId: `reap-thumb-${row.id}` }
          );
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
  const syncStranded = await reapStrandedSyncing();

  return {
    candidates: stuck.length,
    reenqueued,
    exhausted,
    settledWithoutEnrichment,
    thumbnailBackfilled,
    syncStranded,
  };
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
        // See the stuck-sweep guard above — a skipped row is settled, not stuck.
        ne(schema.assets.thumbnailState, "skipped"),
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
      await thumbnailQueue().add(
        JobNames.GenerateThumbnails,
        { assetId: row.id, workspaceId: row.workspaceId },
        { jobId: `reap-thumb-${row.id}` }
      );
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

/**
 * Bounded sweep for rows stranded in sync_state='syncing'. The legacy multipart
 * upload route writes the row, flips sync_state to 'syncing', performs the R2
 * PUT, then writes 'synced' or (on a caught error) 'error'. A process death
 * mid-PUT — an OOM on a multi-GB video — skips both terminal writes and leaves
 * the row at 'syncing' forever, invisible to every other sweep in this file.
 *
 * The bytes died with the process and are not recoverable from here, so this
 * does NOT re-enqueue anything: it writes sync_state='error' so the row stops
 * being invisible and the user can re-upload it. Idempotent — the write drops
 * the row out of this predicate, and the threshold keeps an in-flight upload
 * from being reaped out from under itself.
 */
async function reapStrandedSyncing(): Promise<number> {
  const thresholdMinutes = getSyncStrandedThresholdMinutes();
  const log = logger.child({ component: "reaper", thresholdMinutes });
  const cutoff = sql`now() - (${thresholdMinutes}::int * interval '1 minute')`;
  const batch = getSyncStrandedBatch();

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      updatedAt: schema.assets.updatedAt,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.syncState, "syncing"),
        lt(schema.assets.updatedAt, cutoff)
      )
    )
    .limit(batch);

  log.info(
    { event: "reaper.sync_stranded_scan", candidates: rows.length },
    "reaper stranded-sync scan"
  );

  let reaped = 0;
  for (const row of rows) {
    const stuckForMinutes = Math.round(
      (Date.now() - row.updatedAt.getTime()) / 60000
    );
    try {
      await db
        .update(schema.assets)
        .set({ syncState: "error" })
        .where(
          and(
            eq(schema.assets.id, row.id),
            // Guard against a concurrent completion between the scan and this
            // write — only reap a row that is still stranded.
            eq(schema.assets.syncState, "syncing")
          )
        );
      log.warn(
        {
          event: "reaper.sync_stranded",
          assetId: row.id,
          workspaceId: row.workspaceId,
          stuckForMinutes,
        },
        "asset stranded in sync_state=syncing — marking error"
      );
      reaped += 1;
    } catch (err) {
      // Don't let one bad row stop the sweep — the next tick will retry it.
      log.error(
        {
          event: "reaper.sync_stranded_failed",
          assetId: row.id,
          workspaceId: row.workspaceId,
          stuckForMinutes,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to mark stranded sync row as error"
      );
    }
  }

  return reaped;
}
