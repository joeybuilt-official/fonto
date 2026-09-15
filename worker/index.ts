// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto BullMQ worker entrypoint. This is a bare Node process — NOT a Next.js
// app. It imports the shared queue + processing libraries and drains jobs
// against the Redis/Valkey instance defined by REDIS_URL.
//
// Run locally:
//   pnpm tsx worker/index.ts
//
// In production, the `Dockerfile.worker` image executes the compiled
// `dist/worker/index.js` file.

// OTel SDK is booted via dynamic import inside main() before any other module
// is touched so auto-instrumentations can patch pg/ioredis/http.
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Worker, type Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  getRedisConnection,
  closeRedisConnection,
} from "@/lib/queue/connection";
import {
  QueueNames,
  maintenanceQueue,
  webhookDeliveryQueue,
  clipDedupCheckQueue,
  clipEmbeddingQueue,
  extractEvidenceQueue,
  addAutoClusterFacesJob,
  closeAllQueues,
} from "@/lib/queue/queues";
import {
  JobNames,
  ProcessAssetJobSchema,
  GenerateThumbnailsJobSchema,
  WebhookDeliveryJobSchema,
  EmbedAssetJobSchema,
  ClipDedupCheckJobSchema,
  FaceDetectJobSchema,
  VideoHlsTranscodeJobSchema,
  BackfillFaceCropsJobSchema,
  ImportJobSchema,
  StorageSyncJobSchema,
  ExtractEvidenceJobSchema,
  BackfillEvidenceJobSchema,
  InferDateJobSchema,
  BackfillInferenceJobSchema,
  BackfillReconcileJobSchema,
  AutoClusterFacesJobSchema,
  AutoClusterScanJobSchema,
  BackfillThumbnailsJobSchema,
  BackfillClipJobSchema,
  type AutoClusterFacesJob,
  type ProcessAssetJob,
  type GenerateThumbnailsJob,
  type WebhookDeliveryJob,
  type EmbedAssetJob,
  type ClipDedupCheckJob,
  type FaceDetectJob,
  type VideoHlsTranscodeJob,
  type ImportJob,
  type StorageSyncJob,
  type ExtractEvidenceJob,
  type InferDateJob,
} from "@/lib/queue/jobs";
import { runDriftSweep } from "@/lib/reaudit/driftSweep";
import { describeError } from "@/lib/errors/describeError";
import { isPermanentThumbnailFailure } from "@/lib/processing/permanentThumbnailFailure";
import { isMissingObjectError } from "@/lib/storage/read";
import { nearestNeighbors } from "@/lib/vectors";
import { signWebhookPayload } from "@/lib/webhooks/emit";
import { processAsset } from "@/lib/processing/processAsset";
import { reapStuckAssets } from "@/lib/processing/reapStuckAssets";
import { generateThumbnails } from "@/lib/processing/generateThumbnails";
import { embedAsset } from "@/lib/processing/embedAsset";
import { detectFacesForAsset } from "@/lib/processing/detectFaces";
import { clusterWorkspaceFaces, clusterWorkspaceFacesHNSW } from "@/lib/faces/cluster";
import { pruneAuditLog } from "@/lib/maintenance/auditPrune";
import { runDailyDigest } from "@/lib/notifications/runDailyDigest";
import { transcodeVideoHls } from "@/lib/processing/transcodeVideoHls";
import { backfillThumbnails, backfillClip } from "@/lib/processing/reprocessBackfill";
import { runAutoStack } from "@/lib/stacks/autoStack";
import { backfillStorageMirror } from "@/lib/storage/backfill";
import { reconcileStorageMirror } from "@/lib/storage/reconcile";
import {
  backfillFaceCrops,
  DEFAULT_BACKFILL_BATCH_SIZE,
} from "@/lib/processing/backfillFaceCrops";
import { generateSpriteSheet } from "@/lib/processing/generateSpriteSheet";
import { runImport } from "@/lib/import/runImport";
import { syncAssetStorage } from "@/lib/storage/sync";
import { extractAssetEvidence } from "@/lib/evidence/extractAssetEvidence";
import { backfillEvidence, backfillVariantCandidates } from "@/lib/evidence/backfill";
import { inferAssetDate } from "@/lib/fusion/inferAssetDate";
import { backfillInference } from "@/lib/fusion/backfillInference";
import { applyDateBackfill } from "@/lib/reconcile/dateBackfill";
import { applyBucketReconcile, applyBucketUndo, srcBucketKey } from "@/lib/reconcile/bucketReview";
import { register as metricsRegister } from "@/lib/metrics";
import { startOtel } from "@/lib/otel";

const CONCURRENCY = Math.max(parseInt(process.env.WORKER_CONCURRENCY ?? "4", 10), 1);
// Phase 1.1 — thumbnails worker is CPU-bound (sharp encode) and competes with
// the umbrella asset-processing worker for cores. Default lower than the main
// concurrency to leave headroom for classify/OCR.
const THUMBNAIL_CONCURRENCY = Math.max(
  parseInt(process.env.THUMBNAIL_WORKER_CONCURRENCY ?? "2", 10),
  1
);
// Phase 2.4 — outbound webhook delivery. Network-bound (HTTP POST + wait),
// so concurrency can be higher than CPU-bound workers without contention.
const WEBHOOK_CONCURRENCY = Math.max(
  parseInt(process.env.WEBHOOK_DELIVERY_CONCURRENCY ?? "4", 10),
  1
);
// Phase 4.5 — CLIP-similarity dedup check. Each job is one DB lookup + one
// pgvector NN query. Modest concurrency keeps the index hot without
// hammering Postgres.
const CLIP_DEDUP_CONCURRENCY = Math.max(
  parseInt(process.env.CLIP_DEDUP_WORKER_CONCURRENCY ?? "2", 10),
  1
);
// Phase B3 — mirror-sync. I/O-bound (R2 download + local write). Modest default
// so a burst of uploads to a mirror workspace doesn't saturate disk/bandwidth.
const STORAGE_SYNC_CONCURRENCY = Math.max(
  parseInt(process.env.STORAGE_SYNC_WORKER_CONCURRENCY ?? "3", 10),
  1
);
// Phase 4.5 — re-enqueue delay when the embedding isn't yet present on the
// row (the upstream CLIP-embed job from Phase 4.2 hasn't completed). We don't
// fail the job because there's nothing wrong; we just wait and try again.
const CLIP_DEDUP_RETRY_DELAY_MS = Math.max(
  parseInt(process.env.CLIP_DEDUP_RETRY_DELAY_MS ?? "30000", 10),
  1000
);
// Phase 4.5 hardening — cap the self-re-enqueue so an asset whose CLIP-embed
// never lands (e.g. the R2 original is missing → embed fails permanently)
// cannot loop forever. At the 30s default delay, 40 retries ≈ 20 min of
// waiting before we give up. Giving up leaves `clip_dedup_checked_at` NULL so
// a later backfill sweep (scripts/scan-clip-duplicates.ts) can re-check the
// asset once its embedding finally exists — no data is lost.
const CLIP_DEDUP_MAX_RETRIES = Math.max(
  parseInt(process.env.CLIP_DEDUP_MAX_RETRIES ?? "40", 10),
  1
);
// Phase 4.5 — CLIP similarity threshold. Mirrored from createAssetRow's
// env-aware helper, but read here so the worker stays self-contained.
function clipDedupThreshold(): number {
  const raw = process.env.CLIP_DEDUP_THRESHOLD;
  if (!raw) return 0.92;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return 0.92;
  return n;
}
const WEBHOOK_TIMEOUT_MS = Math.max(
  parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? "10000", 10),
  1000
);
// Phase 4.2 — CLIP embedding worker. Network-bound (POST to plexo-vision)
// but the vision service is itself CPU-bound, so we keep concurrency low by
// default to avoid hammering it.
const CLIP_EMBED_CONCURRENCY = Math.max(
  parseInt(process.env.CLIP_EMBED_CONCURRENCY ?? "4", 10),
  2
);
// E4-M6 — self-re-enqueue delay for clip-embedding jobs that hit a
// preview-required mime whose sharp-decoded preview hasn't landed yet. The
// thumbnail worker produces the preview; this delay gives it time before the
// job is retried. Same profile as the clip-dedup constants above.
const CLIP_EMBED_PREVIEW_DELAY_MS = Math.max(
  parseInt(process.env.CLIP_EMBED_PREVIEW_DELAY_MS ?? "30_000", 10),
  1000
);
const CLIP_EMBED_PREVIEW_MAX_RETRIES = Math.max(
  parseInt(process.env.CLIP_EMBED_PREVIEW_MAX_RETRIES ?? "20", 10),
  1
);
// Phase 5.1 — face detection + ArcFace embedding. Network-bound (POST to
// plexo-vision /v1/faces/detect). Conservative default; the sidecar pins a
// dedicated GPU/CPU pool and we don't want to swamp it.
const FACE_DETECT_CONCURRENCY = Math.max(
  parseInt(process.env.FACE_DETECT_CONCURRENCY ?? "2", 10),
  1
);

// Phase 8b — HLS ladder transcode is CPU + I/O bound. One at a time
// keeps a fat 1080p job from starving the other ladder slots; bump
// via env on hosts that can take it.
const VIDEO_HLS_CONCURRENCY = Math.max(
  parseInt(process.env.VIDEO_HLS_CONCURRENCY ?? "1", 10),
  1
);

// "could not renew lock" cascade fix: CPU-heavy jobs (video probe/thumbnail,
// sharp, ffmpeg) can starve the Node event loop past BullMQ's default 30s
// lock, so a still-running job gets marked stalled, re-runs, piles on more
// load, and the queue wedges (captured backlog grows, HLS never drains). Give
// the heavy workers a generous lock + longer stalled sweep so a briefly-busy
// loop doesn't lose its lock. BullMQ renews at lockDuration/2.
const HEAVY_LOCK_DURATION_MS = Math.max(
  parseInt(process.env.WORKER_LOCK_DURATION_MS ?? `${5 * 60 * 1000}`, 10),
  60_000
);
const HEAVY_STALLED_INTERVAL_MS = Math.max(
  parseInt(process.env.WORKER_STALLED_INTERVAL_MS ?? "60000", 10),
  10_000
);

// Exponential backoff for webhook delivery retries (in milliseconds).
// One entry per delay between attempts: index 0 = delay before attempt 2,
// index 1 = delay before attempt 3, etc. We cap total attempts at 6, so the
// schedule is: attempt 1 (immediate), then waits of 1m, 5m, 15m, 1h, 6h.
// If attempt 6 fails, the row is marked terminally `failed`.
const WEBHOOK_BACKOFF_MS: readonly number[] = [
  60_000, // 1 min   -> attempt 2
  5 * 60_000, // 5 min   -> attempt 3
  15 * 60_000, // 15 min  -> attempt 4
  60 * 60_000, // 1 h     -> attempt 5
  6 * 60 * 60_000, // 6 h     -> attempt 6
];
const WEBHOOK_MAX_ATTEMPTS = 6;
const METRICS_PORT = Math.max(parseInt(process.env.WORKER_METRICS_PORT ?? "9464", 10), 1);

// Reaper scheduler tick in milliseconds. Default 5 minutes. Configurable so
// integration tests can dial it down to seconds without code changes.
const REAPER_INTERVAL_MS = Math.max(
  parseInt(process.env.REAPER_INTERVAL_MS ?? `${5 * 60 * 1000}`, 10),
  1000
);

// Phase 3.2 — audit log retention reaper. Default once per day. Configurable
// so integration tests can dial it down to seconds.
const AUDIT_PRUNE_INTERVAL_MS = Math.max(
  parseInt(process.env.AUDIT_PRUNE_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`, 10),
  1000
);

// Phase 7a — daily activity digest dispatch. Default once per day. Override
// via DIGEST_INTERVAL_MS for local "tick every 30s and watch the logs"
// development.
const DIGEST_INTERVAL_MS = Math.max(
  parseInt(process.env.DIGEST_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`, 10),
  1000
);

// Task 20 (Phase 3) — auto-stacking sweep. Default once per day. Reversible +
// idempotent (suggestStacks excludes already-stacked assets), so re-running is
// safe. Override via AUTO_STACK_INTERVAL_MS for "tick every 60s and watch".
const AUTO_STACK_INTERVAL_MS = Math.max(
  parseInt(process.env.AUTO_STACK_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`, 10),
  1000
);

// M5a (O4) — nightly HNSW auto-cluster sweep. Default once per day at the
// same cadence the NAS cron was meant to run. Override via
// AUTO_CLUSTER_INTERVAL_MS for "tick every 60s and watch" during a rollout.
const AUTO_CLUSTER_INTERVAL_MS = Math.max(
  parseInt(process.env.AUTO_CLUSTER_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`, 10),
  1000
);

// Kill switch for the daily auto-stacking sweep. Default ON. Set
// AUTO_STACK_ENABLED=0 (or false/no) to disable — boot then tears down any
// previously-registered scheduler so the tick actually stops.
const AUTO_STACK_ENABLED = !["0", "false", "no"].includes(
  (process.env.AUTO_STACK_ENABLED ?? "true").trim().toLowerCase()
);

// Phase 1 (faces/UX) — throttled backfill of face-crop derivatives for
// existing faces. DEFAULT-OFF: the recurring schedule is only registered when
// BACKFILL_FACE_CROPS is truthy ("1"/"true"/"yes"), so the heavy crop loop
// never runs unless the operator deliberately turns it on (or enqueues a
// one-off via enqueueBackfillFaceCrops). Small batch (default 25) reuses the
// per-asset shared decode + the heavy lock so a briefly-busy loop keeps its
// lock; idempotent + resumable.
const BACKFILL_FACE_CROPS_ENABLED = ["1", "true", "yes"].includes(
  (process.env.BACKFILL_FACE_CROPS ?? "").trim().toLowerCase()
);
// Interval for the recurring backfill tick. Default 5 minutes — gentle, drains
// the un-cropped backlog batch by batch. Override for testing.
const BACKFILL_FACE_CROPS_INTERVAL_MS = Math.max(
  parseInt(
    process.env.BACKFILL_FACE_CROPS_INTERVAL_MS ?? `${5 * 60 * 1000}`,
    10
  ),
  1000
);
const BACKFILL_FACE_CROPS_BATCH_SIZE = Math.max(
  parseInt(
    process.env.BACKFILL_FACE_CROPS_BATCH_SIZE ??
      `${DEFAULT_BACKFILL_BATCH_SIZE}`,
    10
  ),
  1
);

// Intelligence Core (Phase 3) — extract-evidence worker concurrency. Mostly
// Postgres-bound + one optional Plexo label call, so a few in flight is fine.
const EVIDENCE_EXTRACT_CONCURRENCY = Math.max(
  parseInt(process.env.EVIDENCE_EXTRACT_CONCURRENCY ?? "3", 10),
  1
);
// Intelligence Core (Phase 3) — evidence + variant-candidate backfill sweeps.
// Both DEFAULT-OFF (env-gated) like the face-crop backfill: the schedules are
// only registered when the flag is truthy, so prod is untouched until the
// operator opts in (or enqueues a one-off). The evidence sweep enqueues
// extract-evidence in bounded batches; the variant sweep recomputes candidate
// groups per workspace (idempotent).
const BACKFILL_EVIDENCE_ENABLED = ["1", "true", "yes"].includes(
  (process.env.BACKFILL_EVIDENCE ?? "").trim().toLowerCase()
);
const BACKFILL_EVIDENCE_INTERVAL_MS = Math.max(
  parseInt(process.env.BACKFILL_EVIDENCE_INTERVAL_MS ?? `${5 * 60 * 1000}`, 10),
  1000
);
const BACKFILL_EVIDENCE_BATCH_SIZE = Math.max(
  parseInt(process.env.BACKFILL_EVIDENCE_BATCH_SIZE ?? "100", 10),
  1
);
const VARIANT_CANDIDATES_ENABLED = ["1", "true", "yes"].includes(
  (process.env.BACKFILL_VARIANT_CANDIDATES ?? "").trim().toLowerCase()
);
// Default daily — variant grouping is a whole-workspace recompute, not a
// drain-by-batch sweep, so it runs far less often than the evidence backfill.
const VARIANT_CANDIDATES_INTERVAL_MS = Math.max(
  parseInt(process.env.BACKFILL_VARIANT_CANDIDATES_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`, 10),
  1000
);

// Intelligence Core (Phase 4) — infer-date worker concurrency. Pure CPU + 2
// small reads + 1 upsert per asset, so it can run several in flight.
const INFER_DATE_CONCURRENCY = Math.max(
  parseInt(process.env.INFER_DATE_CONCURRENCY ?? "4", 10),
  1
);
// Intelligence Core (Phase 4) — inference backfill sweep. DEFAULT-OFF (env-gated),
// mirrors the Phase 3 evidence sweep: enqueue infer-date for assets that have
// evidence but no inference proposal yet.
const BACKFILL_INFERENCE_ENABLED = ["1", "true", "yes"].includes(
  (process.env.BACKFILL_INFERENCE ?? "").trim().toLowerCase()
);
const BACKFILL_INFERENCE_INTERVAL_MS = Math.max(
  parseInt(process.env.BACKFILL_INFERENCE_INTERVAL_MS ?? `${5 * 60 * 1000}`, 10),
  1000
);
const BACKFILL_INFERENCE_BATCH_SIZE = Math.max(
  parseInt(process.env.BACKFILL_INFERENCE_BATCH_SIZE ?? "200", 10),
  1
);

// Phase B5 (storage placement) — mirror backfill + reconcile sweeps. Both are
// DEFAULT-OFF and additionally require LOCAL_STORAGE_ROOT (no mount → nothing to
// mirror into), so prod is untouched until the operator provisions the share
// (G1) and opts in (G3). STORAGE_BACKFILL drains existing un-mirrored originals;
// STORAGE_RECONCILE repairs R2↔local divergence nightly.
const STORAGE_BACKFILL_ENABLED =
  !!process.env.LOCAL_STORAGE_ROOT &&
  ["1", "true", "yes"].includes((process.env.STORAGE_BACKFILL ?? "").trim().toLowerCase());
const STORAGE_BACKFILL_INTERVAL_MS = Math.max(
  parseInt(process.env.STORAGE_BACKFILL_INTERVAL_MS ?? `${5 * 60 * 1000}`, 10),
  1000
);
const STORAGE_RECONCILE_ENABLED =
  !!process.env.LOCAL_STORAGE_ROOT &&
  ["1", "true", "yes"].includes((process.env.STORAGE_RECONCILE ?? "").trim().toLowerCase());
const STORAGE_RECONCILE_INTERVAL_MS = Math.max(
  parseInt(process.env.STORAGE_RECONCILE_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`, 10),
  60 * 1000
);

// Phase 2 (media import) — Google Takeout / Amazon ZIP import. Long-running,
// I/O-bound (multi-GB stream-to-disk + member-by-member unzip + per-photo
// ingest). Capped low by default (1–2 per ADR pre-mortem #2: tens-of-GB
// downloads + temp disk on the worker; NAS /tmp ENOSPC is a known foot-gun).
const IMPORT_CONCURRENCY = Math.max(
  parseInt(process.env.IMPORT_WORKER_CONCURRENCY ?? "1", 10),
  1
);

const workers: Worker[] = [];
let metricsServer: ReturnType<typeof createServer> | null = null;

/**
 * Tiny HTTP listener exposing `/metrics` for Prometheus to scrape. Bare
 * Node `http` (no Express) — the worker container has no Next.js to
 * piggyback on. Gated by the same `METRICS_BEARER_TOKEN` env var as the web
 * route; if unset, the endpoint returns 503 instead of leaking metrics
 * anonymously.
 */
function startMetricsServer(): void {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url !== "/metrics") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const expected = process.env.METRICS_BEARER_TOKEN;
    if (!expected) {
      res.statusCode = 503;
      res.end("metrics endpoint disabled (METRICS_BEARER_TOKEN unset)");
      return;
    }
    const auth = req.headers["authorization"];
    const headerValue = Array.isArray(auth) ? auth[0] : auth ?? "";
    const presented = headerValue.startsWith("Bearer ")
      ? headerValue.slice("Bearer ".length).trim()
      : "";
    if (!presented || presented !== expected) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    try {
      const body = await metricsRegister.metrics();
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : "internal error");
    }
  };

  metricsServer = createServer((req, res) => {
    void handler(req, res);
  });
  metricsServer.listen(METRICS_PORT, () => {
    logger.info({ port: METRICS_PORT }, "worker metrics endpoint listening");
  });
  metricsServer.on("error", (err) =>
    logger.error({ err: err.message }, "worker metrics server error")
  );
}

function startAssetProcessingWorker(): Worker<ProcessAssetJob> {
  const w = new Worker<ProcessAssetJob>(
    QueueNames.AssetProcessing,
    async (job: Job<ProcessAssetJob>) => {
      const log = logger.child({
        queue: QueueNames.AssetProcessing,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });

      // Validate payload at the boundary. A malformed job is non-retryable.
      const parsed = ProcessAssetJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid job payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const data = parsed.data;

      // Bump processingAttempts for observability. The DB column is separate
      // from BullMQ's `attemptsMade` so callers (and the admin UI) can see
      // how many times we've tried even after a job has been retried out.
      await db
        .update(schema.assets)
        .set({ processingAttempts: sql`${schema.assets.processingAttempts} + 1` })
        .where(eq(schema.assets.id, data.assetId));

      log.info("processing asset");
      try {
        await processAsset({
          assetId: data.assetId,
          userId: data.userId,
          email: data.email,
          filename: data.filename,
          mimeType: data.mimeType,
          extractedText: data.extractedText ?? null,
        });
        // On success, clear any prior error and (intentionally) keep
        // processingAttempts as a historical counter — useful for retry
        // dashboards.
        await db
          .update(schema.assets)
          .set({ processingError: null })
          .where(eq(schema.assets.id, data.assetId));
        log.info("asset processed");
      } catch (err) {
        // describeError, NOT err.message: an Effect `Data.TaggedError` (e.g.
        // CapabilityUnavailableError) subclasses Error with an EMPTY message,
        // and writing that produced 6,704 rows stamped processing_error='' on
        // 2026-09-04 — unfindable by `IS NULL` and stripped of the one detail
        // that explained them.
        const msg = describeError(err);
        log.error({ err: msg }, "asset processing failed");
        // Distinguish a retryable failure from the final attempt. On a
        // retryable failure keep the row in 'captured' so BullMQ (and, as a
        // backstop, the reaper) retries it. On the LAST attempt terminalize
        // to 'failed' so it stops counting as "processing" forever and
        // surfaces to the user instead of silently vanishing.
        const maxAttempts = job.opts.attempts ?? 1;
        const isTerminal =
          err instanceof UnrecoverableError ||
          job.attemptsMade + 1 >= maxAttempts;
        await db
          .update(schema.assets)
          .set({
            processingError: msg.slice(0, 1000),
            processingState: isTerminal ? "failed" : "captured",
          })
          .where(eq(schema.assets.id, data.assetId))
          .catch(() => undefined);
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: CONCURRENCY,
      lockDuration: HEAVY_LOCK_DURATION_MS,
      stalledInterval: HEAVY_STALLED_INTERVAL_MS,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.AssetProcessing, jobId: job.id }, "job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.AssetProcessing,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.AssetProcessing, err: err.message }, "worker error")
  );

  return w;
}

/**
 * Phase 1.1 — thumbnails worker. Consumes `generate-thumbnails` jobs from the
 * thumbnails queue, downloads the original from R2, encodes 256px + 1080px
 * WebP derivatives via sharp, uploads them under `derivatives/`, and stamps
 * the keys onto the assets row. Independent of the asset-processing worker
 * so a slow Plexo classify call doesn't delay grid thumbnails.
 */
function startThumbnailWorker(): Worker<GenerateThumbnailsJob> {
  const w = new Worker<GenerateThumbnailsJob>(
    QueueNames.Thumbnail,
    async (job: Job<GenerateThumbnailsJob>) => {
      const log = logger.child({
        queue: QueueNames.Thumbnail,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });

      const parsed = GenerateThumbnailsJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid thumbnail payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const data = parsed.data;

      // Mark in-flight so the state column tracks the job rather than the
      // Redis set — mirrors the HLS worker's 'transcoding' stamp.
      await db
        .update(schema.assets)
        // Bump updated_at with it. The reaper's thumbnail backfill filters on
        // `updated_at < cutoff`, so a state write that leaves the timestamp
        // untouched keeps the row eternally selectable — which is how 1,402
        // undecodable DNGs got re-enqueued 200 at a time every tick. Stamping
        // it here gives every attempt one threshold window of quiet, matching
        // what the stuck sweep already does when it re-enqueues.
        .set({ thumbnailState: "generating", updatedAt: sql`now()` })
        .where(eq(schema.assets.id, data.assetId));

      log.info("generating thumbnails");
      try {
        const result = await generateThumbnails({
          assetId: data.assetId,
          workspaceId: data.workspaceId,
        });
        if (result.skipped) {
          log.info({ reason: result.reason }, "thumbnail job skipped");
        } else {
          log.info(
            {
              thumbBytes: result.thumbBytes,
              previewBytes: result.previewBytes,
            },
            "thumbnails generated"
          );
        }
        return result;
      } catch (err) {
        // Only a TERMINAL failure is recorded: an unrecoverable error, or the
        // last configured attempt. A retryable miss stays 'generating' so the
        // column doesn't flap while BullMQ still has attempts left.
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (err instanceof UnrecoverableError || isLastAttempt) {
          // Record the REASON alongside the state (migration 0062). Until this
          // landed, 'failed' was written bare: on 2026-09-01 all 278 failed rows
          // carried no reason, and recovering one meant reconstructing its job
          // id and hand-querying Redis — the exact loop thumbnail_state was
          // introduced to end. Worse, the reason lived only in the retained
          // failed job, which is also what blocks a re-enqueue, so reading it
          // and retrying it were mutually exclusive.
          const reason = describeError(err);
          // Terminal-by-construction vs. genuinely failed. `decodeToBuffer`
          // rejects a mime it has no decoder for (BMP, EPS, ...) — that is not a
          // failure to be retried, it is a format we will never render, and
          // 'skipped' is the state the reaper and the backfill already leave
          // alone. Filing it as 'failed' put 37 permanently-undecodable rows in
          // the user-visible failure count and let the backfill's `image/%`
          // filter re-enqueue them forever. Phase C1 (2026-09-09) generalized
          // this from one substring to the full set of known-permanent
          // signatures — see permanentThumbnailFailure.ts for the evidence
          // behind each one.
          const undecodable = isPermanentThumbnailFailure(reason);
          await db
            .update(schema.assets)
            .set({
              thumbnailState: undecodable ? "skipped" : "failed",
              thumbnailError: reason.slice(0, 1000),
              updatedAt: sql`now()`,
            })
            .where(eq(schema.assets.id, data.assetId));
        }
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: THUMBNAIL_CONCURRENCY,
      lockDuration: HEAVY_LOCK_DURATION_MS,
      stalledInterval: HEAVY_STALLED_INTERVAL_MS,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.Thumbnail, jobId: job.id }, "thumbnail job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.Thumbnail,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "thumbnail job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.Thumbnail, err: err.message }, "thumbnail worker error")
  );

  return w;
}

/**
 * Phase B3 (storage placement) — mirror-sync worker. Streams a `mirror`-policy
 * asset's original R2→local, size-verifies, and stamps
 * local_original_stored_at. No-ops for non-mirror policies + already-synced
 * rows, so it's safe to enqueue on every upload.
 */
function startStorageSyncWorker(): Worker<StorageSyncJob> {
  const w = new Worker<StorageSyncJob>(
    QueueNames.StorageSync,
    async (job: Job<StorageSyncJob>) => {
      const log = logger.child({
        queue: QueueNames.StorageSync,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });

      const parsed = StorageSyncJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid storage-sync payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const data = parsed.data;

      const result = await syncAssetStorage(data.assetId, data.workspaceId).catch(
        (err: unknown) => {
          // The original is GONE from R2. Retrying cannot conjure bytes back, so
          // spending five attempts per tick on it only floods the log: 18 such
          // assets produced 18,355 failures in 17 hours on 2026-09-08 and rotated
          // the worker's 50 MB log faster than it could be read back.
          if (isMissingObjectError(err)) {
            throw new UnrecoverableError(
              `original missing from object storage: ${describeError(err)}`,
            );
          }
          throw err;
        },
      );
      if (!result.synced) {
        log.info({ reason: result.reason }, "storage-sync skipped");
      } else {
        log.info({ bytes: result.bytes }, "storage-sync mirrored original");
      }
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: STORAGE_SYNC_CONCURRENCY,
      lockDuration: HEAVY_LOCK_DURATION_MS,
      stalledInterval: HEAVY_STALLED_INTERVAL_MS,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.StorageSync, jobId: job.id }, "storage-sync job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.StorageSync,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "storage-sync job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.StorageSync, err: err.message }, "storage-sync worker error")
  );

  return w;
}

/**
 * Phase 2.4 — outbound webhook delivery worker. Pulls delivery rows by id,
 * POSTs the payload with Stripe-style HMAC signature headers, and updates
 * the row's state. On failure, increments `attempts`, computes the next
 * `nextAttemptAt` from the backoff schedule, and re-enqueues with BullMQ's
 * `delay` option. After WEBHOOK_MAX_ATTEMPTS, marks `failed` and stops.
 *
 * Network errors and non-2xx responses both count as failures. Body of the
 * response is truncated to 8 KiB before persisting.
 */
function startWebhookDeliveryWorker(): Worker<WebhookDeliveryJob> {
  const w = new Worker<WebhookDeliveryJob>(
    QueueNames.WebhookDelivery,
    async (job: Job<WebhookDeliveryJob>) => {
      const log = logger.child({
        queue: QueueNames.WebhookDelivery,
        jobId: job.id,
        deliveryId: job.data?.deliveryId,
        attempt: job.data?.attempt,
      });

      const parsed = WebhookDeliveryJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid webhook delivery payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const { deliveryId } = parsed.data;

      const [delivery] = await db
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, deliveryId))
        .limit(1);
      if (!delivery) {
        log.warn("delivery row missing — dropping job");
        return;
      }
      if (delivery.state === "delivered" || delivery.state === "failed") {
        log.info({ state: delivery.state }, "delivery already terminal — skipping");
        return;
      }

      const [endpoint] = await db
        .select()
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, delivery.endpointId))
        .limit(1);
      if (!endpoint) {
        log.warn("endpoint missing — marking failed");
        await db
          .update(schema.webhookDeliveries)
          .set({ state: "failed", lastAttemptAt: new Date() })
          .where(eq(schema.webhookDeliveries.id, deliveryId));
        return;
      }
      if (endpoint.disabledAt) {
        log.info("endpoint disabled — marking failed");
        await db
          .update(schema.webhookDeliveries)
          .set({ state: "failed", lastAttemptAt: new Date() })
          .where(eq(schema.webhookDeliveries.id, deliveryId));
        return;
      }

      const body = JSON.stringify(delivery.payload);
      const eventType = delivery.eventType;
      const sig = signWebhookPayload(body, endpoint.signingSecret);

      const attemptNumber = delivery.attempts + 1;
      let responseStatus: number | null = null;
      let responseBody: string | null = null;
      let success = false;
      let errMsg: string | null = null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fonto-Event": eventType,
            "X-Fonto-Delivery": deliveryId,
            "X-Fonto-Signature": sig.header,
            "User-Agent": "Fonto-Webhook/1.0",
          },
          body,
          signal: controller.signal,
        });
        responseStatus = res.status;
        try {
          const text = await res.text();
          responseBody = text.slice(0, 8 * 1024);
        } catch {
          responseBody = null;
        }
        success = res.status >= 200 && res.status < 300;
        if (!success) {
          errMsg = `non-2xx status ${res.status}`;
        }
      } catch (err) {
        errMsg = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }

      const now = new Date();
      if (success) {
        await db
          .update(schema.webhookDeliveries)
          .set({
            state: "delivered",
            attempts: attemptNumber,
            lastAttemptAt: now,
            lastResponseStatus: responseStatus,
            lastResponseBody: responseBody,
          })
          .where(eq(schema.webhookDeliveries.id, deliveryId));
        log.info({ status: responseStatus }, "webhook delivered");
        return;
      }

      // Failure path: either retry or mark failed.
      if (attemptNumber >= WEBHOOK_MAX_ATTEMPTS) {
        await db
          .update(schema.webhookDeliveries)
          .set({
            state: "failed",
            attempts: attemptNumber,
            lastAttemptAt: now,
            lastResponseStatus: responseStatus,
            lastResponseBody: responseBody ?? (errMsg ? errMsg.slice(0, 8 * 1024) : null),
            nextAttemptAt: null,
          })
          .where(eq(schema.webhookDeliveries.id, deliveryId));
        log.warn({ err: errMsg, status: responseStatus }, "webhook delivery exhausted");
        return;
      }

      // Schedule next attempt.
      const delayMs = WEBHOOK_BACKOFF_MS[attemptNumber - 1] ?? WEBHOOK_BACKOFF_MS[WEBHOOK_BACKOFF_MS.length - 1];
      const nextAt = new Date(Date.now() + delayMs);
      await db
        .update(schema.webhookDeliveries)
        .set({
          state: "pending",
          attempts: attemptNumber,
          lastAttemptAt: now,
          lastResponseStatus: responseStatus,
          lastResponseBody: responseBody ?? (errMsg ? errMsg.slice(0, 8 * 1024) : null),
          nextAttemptAt: nextAt,
        })
        .where(eq(schema.webhookDeliveries.id, deliveryId));
      try {
        await webhookDeliveryQueue().add(
          JobNames.DeliverWebhook,
          { deliveryId, attempt: attemptNumber + 1 },
          { delay: delayMs }
        );
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "failed to re-enqueue webhook retry");
      }
      log.info(
        { err: errMsg, status: responseStatus, nextAttemptAt: nextAt.toISOString() },
        "webhook delivery retry scheduled"
      );
    },
    {
      connection: getRedisConnection(),
      concurrency: WEBHOOK_CONCURRENCY,
    }
  );

  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.WebhookDelivery,
        jobId: job?.id,
        err: err.message,
      },
      "webhook delivery worker error"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.WebhookDelivery, err: err.message }, "webhook worker error")
  );

  return w;
}

/**
 * Phase 4.2 — CLIP image embedding worker. Drains the `clip-embedding` queue:
 * downloads an asset's preview derivative (or original if preview missing)
 * from R2, POSTs to plexo-vision's `/vision/clip/image`, and writes the
 * returned 512-dim vector to `assets.clip_vec`.
 *
 * Skips non-image MIME types silently (returns success — BullMQ won't retry).
 * Non-2xx from vision throws; BullMQ retries per queue policy. If the vision
 * service is unconfigured the job no-ops with a skip reason.
 */
function startClipEmbeddingWorker(): Worker<EmbedAssetJob> {
  const w = new Worker<EmbedAssetJob>(
    QueueNames.ClipEmbedding,
    async (job: Job<EmbedAssetJob>) => {
      const log = logger.child({
        queue: QueueNames.ClipEmbedding,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });

      const parsed = EmbedAssetJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid embed payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const data = parsed.data;

      log.info("embedding asset");
      const result = await embedAsset({
        assetId: data.assetId,
        workspaceId: data.workspaceId,
      });
      if (result.skipped) {
        // E4-M6 — a preview-required mime whose quick-decoded preview hasn't
        // landed yet is a transient condition, not a skip: re-enqueue with a
        // delay (bounded) so the thumbnail worker can produce the preview and
        // the vector still lands automatically — the operator never has to
        // run `backfill:clip` for the upload path. Mirrors the clip-dedup
        // worker's self-re-enqueue below. All other skip reasons are final.
        if (
          result.reason === "preview-not-ready" &&
          (data.previewRetries ?? 0) < CLIP_EMBED_PREVIEW_MAX_RETRIES
        ) {
          const retries = (data.previewRetries ?? 0) + 1;
          log.info({ retries, max: CLIP_EMBED_PREVIEW_MAX_RETRIES }, "preview not ready; re-enqueuing embed");
          await clipEmbeddingQueue().add(
            JobNames.EmbedAsset,
            { assetId: data.assetId, workspaceId: data.workspaceId, previewRetries: retries },
            { delay: CLIP_EMBED_PREVIEW_DELAY_MS }
          );
          return { skipped: true, reason: "preview-not-ready" };
        }
        log.info({ reason: result.reason, modelId: result.modelId }, "embed job skipped");
      } else {
        log.info(
          { modelId: result.modelId, dimensions: result.dimensions },
          "asset embedded"
        );
      }
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: CLIP_EMBED_CONCURRENCY,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.ClipEmbedding, jobId: job.id }, "embed job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.ClipEmbedding,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "embed job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.ClipEmbedding, err: err.message }, "embed worker error")
  );

  return w;
}

/**
 * Phase 4.5 — CLIP-similarity dedup check worker. Pulled from the
 * `clip-dedup-check` queue when either (a) the inline embed in
 * `createAssetRow()` exceeded its budget, or (b) a backfill sweep enqueued
 * the asset. Re-enqueues itself with a delay if the upstream CLIP-embed
 * job (Phase 4.2) hasn't populated `clip_vec` yet — it's expected, not an
 * error.
 */
function startClipDedupCheckWorker(): Worker<ClipDedupCheckJob> {
  const w = new Worker<ClipDedupCheckJob>(
    QueueNames.ClipDedupCheck,
    async (job: Job<ClipDedupCheckJob>) => {
      const log = logger.child({
        queue: QueueNames.ClipDedupCheck,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });

      const parsed = ClipDedupCheckJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid clip-dedup payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const { assetId, workspaceId } = parsed.data;

      // NB: a pgvector column read via raw `db.execute` comes back as a string
      // literal ("[...]"), not a number[]. nearestNeighbors() normalises it.
      type ClipVecRow = { clip_vec: string | null; lifecycle_state: string };
      let rows: ClipVecRow[] = [];
      try {
        const result = await db.execute<ClipVecRow>(
          sql`SELECT clip_vec, lifecycle_state FROM fonto.assets WHERE id = ${assetId} LIMIT 1`
        );
        rows = Array.isArray(result)
          ? (result as unknown as ClipVecRow[])
          : ((result as unknown as { rows?: ClipVecRow[] }).rows ?? []);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "clip_vec column unavailable — skipping dedup check"
        );
        return { skipped: true, reason: "clip_vec column missing" };
      }

      const row = rows[0];
      if (!row) return { skipped: true, reason: "asset missing" };
      if (row.lifecycle_state !== "active") {
        await db
          .update(schema.assets)
          .set({ clipDedupCheckedAt: new Date() })
          .where(eq(schema.assets.id, assetId))
          .catch(() => undefined);
        return { skipped: true, reason: "lifecycle" };
      }

      if (!row.clip_vec || row.clip_vec.length === 0) {
        const retries = parsed.data.dedupRetries ?? 0;
        if (retries >= CLIP_DEDUP_MAX_RETRIES) {
          // The upstream embed never populated clip_vec (commonly a missing
          // R2 original). Stop the self-re-enqueue loop. Leave
          // clip_dedup_checked_at NULL so a backfill sweep can re-check the
          // asset if/when its embedding lands — the row and any other data
          // are untouched.
          log.warn(
            { retries, maxRetries: CLIP_DEDUP_MAX_RETRIES },
            "clip_vec still missing after max retries; giving up (asset preserved for backfill)"
          );
          return { skipped: true, reason: "clip_vec pending — gave up" };
        }
        log.info({ retries }, "clip_vec not yet populated; re-enqueuing");
        await clipDedupCheckQueue().add(
          JobNames.ClipDedupCheck,
          { assetId, workspaceId, dedupRetries: retries + 1 },
          { delay: CLIP_DEDUP_RETRY_DELAY_MS }
        );
        return { skipped: true, reason: "clip_vec pending" };
      }

      // Phase 4.3's nearestNeighbors signature: (workspaceId, vec, limit, threshold).
      // 4.5 wanted a richer options object with excludeAssetId; filter inline.
      const matches = (await nearestNeighbors(
        workspaceId,
        row.clip_vec,
        5,
        clipDedupThreshold()
      )).filter((m) => m.assetId !== assetId);

      if (matches.length > 0) {
        log.info(
          { matchCount: matches.length, top: matches[0] },
          "clip-dedup match(es) found"
        );
      }

      await db
        .update(schema.assets)
        .set({ clipDedupCheckedAt: new Date() })
        .where(eq(schema.assets.id, assetId));

      return { matches: matches.length };
    },
    {
      connection: getRedisConnection(),
      concurrency: CLIP_DEDUP_CONCURRENCY,
    }
  );

  w.on("failed", (job, err) =>
    logger.error(
      { queue: QueueNames.ClipDedupCheck, jobId: job?.id, err: err.message },
      "clip-dedup worker error"
    )
  );
  w.on("error", (err) =>
    logger.error(
      { queue: QueueNames.ClipDedupCheck, err: err.message },
      "clip-dedup worker error"
    )
  );

  return w;
}

/**
 * Phase 5.1 — face detection + ArcFace embedding worker. Drains the
 * `face-detect` queue: downloads the asset's preview from R2, POSTs to
 * `{PLEXO_VISION_URL}/v1/faces/detect`, and inserts one
 * `fonto.face_instances` row per detection.
 *
 * `detectFacesForAsset()` swallows soft failures (sidecar unconfigured,
 * non-image MIME, R2 miss) and returns without throwing — the worker logs
 * them and the job succeeds. Hard failures (DB write error) bubble up and
 * BullMQ retries per the queue policy.
 */
// Phase 5.x — auto-cluster faces after detection so the People view
// populates without a manual POST /faces/cluster. Clustering re-scans the
// whole workspace, so we debounce per workspace: a burst of uploads
// coalesces into a single clustering pass ~45s after the last face-detect.
// In-memory + best-effort — idempotent re-clustering means a missed run
// (process restart) just waits for the next upload.
const FACE_CLUSTER_DEBOUNCE_MS = 45_000;
// Track A — operational escape hatch. When the workspace is being bulk-
// reprocessed (or the long-term GPU-clustering port is in flight), every
// face-detect completion otherwise re-arms a 20k-face DBSCAN that 100%-pegs
// the worker's single-threaded event loop and starves asset-processing.
// FACE_CLUSTER_DISABLED=1 short-circuits the schedule; a final cluster pass
// can be triggered manually once the reprocess drains.
const FACE_CLUSTER_DISABLED = process.env.FACE_CLUSTER_DISABLED === "1";
const pendingClusterTimers = new Map<string, NodeJS.Timeout>();
function scheduleFaceCluster(workspaceId: string): void {
  if (FACE_CLUSTER_DISABLED) return;
  const existing = pendingClusterTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingClusterTimers.delete(workspaceId);
    clusterWorkspaceFaces(workspaceId)
      .then((stats) =>
        logger.info({ queue: QueueNames.FaceDetect, workspaceId, ...stats }, "auto-cluster complete")
      )
      .catch((err) =>
        logger.warn(
          { workspaceId, err: err instanceof Error ? err.message : String(err) },
          "auto-cluster failed"
        )
      );
  }, FACE_CLUSTER_DEBOUNCE_MS);
  if (typeof t.unref === "function") t.unref();
  pendingClusterTimers.set(workspaceId, t);
}

function startFaceDetectWorker(): Worker<FaceDetectJob> {
  const w = new Worker<FaceDetectJob>(
    QueueNames.FaceDetect,
    async (job: Job<FaceDetectJob>) => {
      const log = logger.child({
        queue: QueueNames.FaceDetect,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });

      const parsed = FaceDetectJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid face-detect payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const { assetId } = parsed.data;

      log.info("detecting faces");
      await detectFacesForAsset(assetId);
      // Trigger a debounced re-cluster for this asset's workspace.
      const [row] = await db
        .select({ workspaceId: schema.assets.workspaceId })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      if (row) scheduleFaceCluster(row.workspaceId);
      log.info("face-detect job complete");
    },
    {
      connection: getRedisConnection(),
      concurrency: FACE_DETECT_CONCURRENCY,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.FaceDetect, jobId: job.id }, "face-detect job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.FaceDetect,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "face-detect job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.FaceDetect, err: err.message }, "face-detect worker error")
  );

  return w;
}

/**
 * Intelligence Core (Phase 3) — per-asset evidence extraction worker. Runs the
 * Fonto-local adapters (identity bound, EXIF, filename, fs-mtime, OCR-date) plus
 * the optional Plexo scene-label adapter for one asset, and writes
 * `fonto.image_date_evidence` rows idempotently. No fusion here — that is Phase
 * 4. Deterministic + idempotent, so a retry re-derives the same rows.
 */
function startExtractEvidenceWorker(): Worker<ExtractEvidenceJob> {
  const w = new Worker<ExtractEvidenceJob>(
    QueueNames.ExtractEvidence,
    async (job: Job<ExtractEvidenceJob>) => {
      const log = logger.child({
        queue: QueueNames.ExtractEvidence,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });
      const parsed = ExtractEvidenceJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid extract-evidence payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const result = await extractAssetEvidence(parsed.data.assetId);
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: EVIDENCE_EXTRACT_CONCURRENCY,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.ExtractEvidence, jobId: job.id }, "extract-evidence completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.ExtractEvidence,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "extract-evidence failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.ExtractEvidence, err: err.message }, "extract-evidence worker error")
  );

  return w;
}

/**
 * Intelligence Core (Phase 4) — per-asset date-fusion worker. Reads the asset's
 * evidence rows + stored captured_at, runs the pure fusion engine, and upserts
 * one `fonto.image_date_inference` proposal. PROPOSE-DON'T-OVERWRITE: never
 * touches captured_at and never clobbers a confirmed/overridden human decision.
 */
function startInferDateWorker(): Worker<InferDateJob> {
  const w = new Worker<InferDateJob>(
    QueueNames.InferDate,
    async (job: Job<InferDateJob>) => {
      const log = logger.child({
        queue: QueueNames.InferDate,
        jobId: job.id,
        assetId: job.data?.assetId,
        attempt: job.attemptsMade + 1,
      });
      const parsed = InferDateJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid infer-date payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      return await inferAssetDate(parsed.data.assetId);
    },
    {
      connection: getRedisConnection(),
      concurrency: INFER_DATE_CONCURRENCY,
    }
  );

  w.on("failed", (job, err) =>
    logger.error(
      { queue: QueueNames.InferDate, jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
      "infer-date failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.InferDate, err: err.message }, "infer-date worker error")
  );

  return w;
}

/**
 * Phase 8b — HLS ladder transcode + sprite worker.
 *
 * One job per video. Steps:
 *   1. Mark assets.hls_state = 'transcoding'.
 *   2. transcodeVideoHls() — uploads master + per-rendition playlists
 *      + .ts segments to R2.
 *   3. probeVideo() to seed sprite-generator dimensions (cheap; we
 *      could pass them through the job payload but reading from the
 *      row keeps the payload tiny + crash-resilient).
 *   4. generateSpriteSheet() — uploads sprite.jpg.
 *   5. Mark hls_state='ready' + persist masterKey + renditions +
 *      spriteKey + spriteMeta.
 *
 * Failure path: catch + mark hls_state='failed'. The API endpoint will
 * re-enqueue on the next request.
 */
function startVideoHlsTranscodeWorker(): Worker<VideoHlsTranscodeJob> {
  const w = new Worker<VideoHlsTranscodeJob>(
    QueueNames.VideoHlsTranscode,
    async (job: Job<VideoHlsTranscodeJob>) => {
      const log = logger.child({
        queue: QueueNames.VideoHlsTranscode,
        jobId: job.id,
        assetId: job.data?.assetId,
      });

      const parsed = VideoHlsTranscodeJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid hls-transcode payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const { assetId, workspaceId } = parsed.data;

      const [asset] = await db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      if (!asset) {
        log.warn("asset row vanished — skipping");
        return;
      }

      // Mark transcoding so the API exposes a stable status and a
      // racy second request doesn't enqueue a duplicate.
      await db
        .update(schema.assets)
        .set({ hlsState: "transcoding" })
        .where(eq(schema.assets.id, assetId));

      try {
        log.info("transcoding ladder");
        const ladder = await transcodeVideoHls({
          workspaceId,
          assetId,
          filename: asset.filename,
        });

        // Sprite needs duration; prefer the persisted value, fall back
        // to a re-probe if 8a hasn't populated it (legacy rows).
        const durationSec = asset.durationSeconds ?? null;
        const srcW = asset.videoWidth ?? null;
        const srcH = asset.videoHeight ?? null;
        if (durationSec == null || srcW == null || srcH == null) {
          log.info("video metadata missing — re-probing source for sprite");
          // We don't have a local copy; quick re-probe via R2 presigned
          // URL would require extra plumbing. For now, skip sprite if
          // we can't size it confidently. The player still gets HLS;
          // hover-scrub just renders without thumbnails.
        }

        let spriteKey: string | null = null;
        let spriteMeta: unknown = null;
        if (durationSec != null && durationSec > 0) {
          log.info("generating sprite sheet");
          const sprite = await generateSpriteSheet({
            workspaceId,
            assetId,
            filename: asset.filename,
            durationSec,
            sourceWidth: srcW,
            sourceHeight: srcH,
          });
          spriteKey = sprite.spriteKey;
          spriteMeta = sprite.meta;
        } else {
          log.warn("skipping sprite — duration unknown");
        }

        await db
          .update(schema.assets)
          .set({
            hlsState: "ready",
            hlsMasterKey: ladder.masterKey,
            hlsRenditions: ladder.renditions,
            spriteKey,
            spriteMeta,
          })
          .where(eq(schema.assets.id, assetId));

        log.info(
          { masterKey: ladder.masterKey, renditions: ladder.renditions.length, sprite: !!spriteKey },
          "hls transcode complete"
        );
      } catch (err) {
        await db
          .update(schema.assets)
          .set({ hlsState: "failed" })
          .where(eq(schema.assets.id, assetId));
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: VIDEO_HLS_CONCURRENCY,
      lockDuration: HEAVY_LOCK_DURATION_MS,
      stalledInterval: HEAVY_STALLED_INTERVAL_MS,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.VideoHlsTranscode, jobId: job.id }, "hls transcode job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.VideoHlsTranscode,
        jobId: job?.id,
        assetId: job?.data?.assetId,
        err: err.message,
      },
      "hls transcode job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.VideoHlsTranscode, err: err.message }, "hls transcode worker error")
  );

  return w;
}

/**
 * Phase 2 (media import) — Google Takeout / Amazon Photos import worker.
 * Drains the `media-import` queue: loads the import_jobs row, streams the
 * archive (Drive download for Takeout, or a local upload path for Amazon),
 * walks it member-by-member, and feeds each media file to createAssetRow with
 * the Takeout sidecar metadata as an override. Progress + resume are tracked
 * on the import_jobs row by runImport(); a ReconnectRequiredError flips the
 * job to failed without crashing the worker. Heavy lock (long-running stream).
 */
function startImportWorker(): Worker<ImportJob> {
  const w = new Worker<ImportJob>(
    QueueNames.Import,
    async (job: Job<ImportJob>) => {
      const log = logger.child({
        queue: QueueNames.Import,
        jobId: job.id,
        importJobId: job.data?.importJobId,
        provider: job.data?.provider,
      });

      const parsed = ImportJobSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ err: parsed.error.flatten() }, "invalid import payload");
        throw new UnrecoverableError(`invalid payload: ${parsed.error.message}`);
      }
      const data = parsed.data;

      log.info("import job starting");
      await runImport({
        importJobId: data.importJobId,
        workspaceId: data.workspaceId,
        userId: data.userId,
        provider: data.provider,
        driveFileId: data.driveFileId,
        uploadTmpPath: data.uploadTmpPath,
      });
      log.info("import job handler returned");
    },
    {
      connection: getRedisConnection(),
      concurrency: IMPORT_CONCURRENCY,
      lockDuration: HEAVY_LOCK_DURATION_MS,
      stalledInterval: HEAVY_STALLED_INTERVAL_MS,
    }
  );

  w.on("completed", (job) =>
    logger.info({ queue: QueueNames.Import, jobId: job.id }, "import job completed")
  );
  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.Import,
        jobId: job?.id,
        importJobId: job?.data?.importJobId,
        err: err.message,
      },
      "import job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.Import, err: err.message }, "import worker error")
  );

  return w;
}

/**
 * BullMQ marker class to opt out of retries. Re-implemented here to avoid
 * importing the named export by path — the type lives at the package root
 * but has historically shifted between versions.
 */
class UnrecoverableError extends Error {
  name = "UnrecoverableError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Maintenance worker — single-concurrency consumer for the maintenance queue.
 * Today it only handles `reap-stuck-assets`; future housekeeping jobs (orphan
 * R2 object sweep, audit-log compaction, etc.) can land on the same queue.
 *
 * Concurrency is fixed at 1 deliberately: the reaper takes table-level locks
 * on the assets table and we never want two sweeps overlapping anyway.
 */
function startMaintenanceWorker(): Worker {
  const w = new Worker(
    QueueNames.Maintenance,
    async (job: Job) => {
      const log = logger.child({
        queue: QueueNames.Maintenance,
        jobId: job.id,
        name: job.name,
      });
      if (job.name === JobNames.ReapStuckAssets) {
        log.info("reaper tick start");
        const result = await reapStuckAssets();
        log.info(
          {
            candidates: result.candidates,
            reenqueued: result.reenqueued,
            exhausted: result.exhausted,
            settledWithoutEnrichment: result.settledWithoutEnrichment,
          },
          "reaper tick complete"
        );
        return result;
      }
      if (job.name === JobNames.PruneAuditLog) {
        // Phase 3.2 — daily audit retention sweep. The pruner itself emits
        // structured pino logs (component=audit.prune); we just delegate.
        const result = await pruneAuditLog();
        return result;
      }
      if (job.name === JobNames.DailyDigest) {
        // Phase 7a — daily activity digest. Iterates (member, workspace)
        // pairs; emits one stub email per member-with-content.
        const result = await runDailyDigest();
        log.info(result, "daily digest tick complete");
        return result;
      }
      if (job.name === JobNames.ReconcileStorageUsage) {
        // Phase 9.1 — recompute usage_bytes for every workspace from the live
        // asset table, correcting any drift from incremental updates.
        const result = await reconcileStorageUsage();
        log.info(result, "storage reconcile tick complete");
        return result;
      }
      if (job.name === JobNames.AutoStack) {
        // Task 20 (Phase 3) — materialise conservative stack suggestions
        // (bursts / screenshot-runs / near-dups). Reversible; sets stack_id
        // only, never hides/deletes members.
        log.info("auto-stack tick start");
        const result = await runAutoStack();
        log.info(result, "auto-stack tick complete");
        return result;
      }
      if (job.name === JobNames.BackfillFaceCrops) {
        // Phase 1 (faces/UX) — process one small batch of un-cropped faces.
        // Idempotent + resumable (selects face_crop_key IS NULL only). The
        // crop loop is sharp-heavy → leans on the heavy lock below.
        const parsed = BackfillFaceCropsJobSchema.safeParse(job.data ?? {});
        const batchSize = parsed.success
          ? parsed.data.batchSize ?? BACKFILL_FACE_CROPS_BATCH_SIZE
          : BACKFILL_FACE_CROPS_BATCH_SIZE;
        log.info({ batchSize }, "face-crop backfill tick start");
        const result = await backfillFaceCrops(batchSize);
        log.info(result, "face-crop backfill tick complete");
        return result;
      }
      if (job.name === JobNames.BackfillStorageMirror) {
        // Phase B5 — enqueue mirror-sync for a bounded batch of un-mirrored
        // originals in mirror/local_only workspaces. Resumable + throttled.
        log.info("storage-mirror backfill tick start");
        const result = await backfillStorageMirror();
        log.info(result, "storage-mirror backfill tick complete");
        return result;
      }
      if (job.name === JobNames.ReconcileStorageMirror) {
        // Phase B5 — nightly R2↔local divergence repair for stamped mirror
        // assets (restore local, re-push to R2, or flag both-gone data loss).
        log.info("storage-mirror reconcile tick start");
        const result = await reconcileStorageMirror();
        log.info(result, "storage-mirror reconcile tick complete");
        return result;
      }
      if (job.name === JobNames.BackfillEvidence) {
        // Intelligence Core (Phase 3) — enqueue extract-evidence for one bounded
        // batch of assets that have no evidence rows yet. Resumable + idempotent.
        const parsed = BackfillEvidenceJobSchema.safeParse(job.data ?? {});
        const batchSize = parsed.success
          ? parsed.data.batchSize ?? BACKFILL_EVIDENCE_BATCH_SIZE
          : BACKFILL_EVIDENCE_BATCH_SIZE;
        log.info({ batchSize }, "evidence backfill tick start");
        const result = await backfillEvidence(batchSize);
        log.info(result, "evidence backfill tick complete");
        return result;
      }
      if (job.name === JobNames.BackfillVariantCandidates) {
        // Intelligence Core (Phase 3) — recompute candidate variant groups for
        // every workspace with active image assets. Idempotent per workspace.
        log.info("variant-candidate backfill tick start");
        const result = await backfillVariantCandidates();
        log.info(result, "variant-candidate backfill tick complete");
        return result;
      }
      if (job.name === JobNames.BackfillInference) {
        // Intelligence Core (Phase 4) — enqueue infer-date for one bounded batch
        // of assets that have evidence but no inference proposal yet. Resumable.
        const parsed = BackfillInferenceJobSchema.safeParse(job.data ?? {});
        const batchSize = parsed.success
          ? parsed.data.batchSize ?? BACKFILL_INFERENCE_BATCH_SIZE
          : BACKFILL_INFERENCE_BATCH_SIZE;
        log.info({ batchSize }, "inference backfill tick start");
        const result = await backfillInference(batchSize);
        log.info(result, "inference backfill tick complete");
        return result;
      }
      if (job.name === JobNames.BackfillThumbnails) {
        // M5d — on-demand thumbnail backfill (the /admin/reprocess button).
        // Same predicate + reclaim as scripts/backfill-thumbnails.ts, worker-side.
        const parsed = BackfillThumbnailsJobSchema.safeParse(job.data ?? {});
        const batchSize = parsed.success
          ? parsed.data.batchSize ?? 200
          : 200;
        log.info({ batchSize }, "thumbnail backfill start");
        const result = await backfillThumbnails(batchSize);
        log.info(result, "thumbnail backfill complete");
        return result;
      }
      if (job.name === JobNames.BackfillClip) {
        // M5d — on-demand CLIP embedding backfill (the /admin/reprocess button).
        // Same predicate + reclaim as scripts/backfill-clip-embeddings.ts, worker-side.
        const parsed = BackfillClipJobSchema.safeParse(job.data ?? {});
        const batchSize = parsed.success
          ? parsed.data.batchSize ?? 200
          : 200;
        log.info({ batchSize }, "clip backfill start");
        const result = await backfillClip(batchSize);
        log.info(result, "clip backfill complete");
        return result;
      }
      if (job.name === JobNames.BackfillReconcile) {
        // Intelligence Core (Phase 8) — library-wide date reconcile. Commits the
        // auto-commit date band for one workspace, idempotently + resumably.
        // Operator-enqueued only (gated mass commit).
        const parsed = BackfillReconcileJobSchema.safeParse(job.data ?? {});
        if (!parsed.success) {
          log.warn({ issues: parsed.error.issues }, "backfill-reconcile bad payload — ignoring");
          return null;
        }
        // M15.1 (ADR 0012) — apply-to-bucket variant: reversible action over one
        // reason-bucket of the review band. Predicate re-resolved each batch.
        if (parsed.data.bucket) {
          const b = parsed.data.bucket;
          // ADR 0059 — normalise: prefer the opaque bucketKey; fall back to the
          // legacy {evidenceSource, conflict} pair from in-flight queued jobs.
          const bucketKey =
            b.bucketKey ?? srcBucketKey(b.evidenceSource ?? null, b.conflict ?? false);
          if (b.undo) {
            log.info({ workspaceId: parsed.data.workspaceId, bucketKey }, "bucket undo start");
            const ures = await applyBucketUndo(parsed.data.workspaceId, {
              bucketKey,
              batchSize: parsed.data.batchSize,
            });
            log.info(ures, "bucket undo complete");
            return ures;
          }
          log.info({ workspaceId: parsed.data.workspaceId, bucketKey }, "bucket reconcile start");
          const bres = await applyBucketReconcile(parsed.data.workspaceId, {
            bucketKey,
            action: b.action,
            batchSize: parsed.data.batchSize,
            maxRows: parsed.data.maxRows,
          });
          log.info(bres, "bucket reconcile complete");
          return bres;
        }
        log.info({ workspaceId: parsed.data.workspaceId }, "date reconcile start");
        const result = await applyDateBackfill(parsed.data.workspaceId, {
          dryRun: false,
          batchSize: parsed.data.batchSize,
          maxRows: parsed.data.maxRows,
        });
        log.info(result, "date reconcile complete");
        return result;
      }
      if (job.name === JobNames.AutoClusterFaces) {
        // M15 closeout — nightly HNSW face clustering. No 50k cap; no embedding
        // vectors loaded into Node memory. DB-side pgvector HNSW does the work.
        const parsed = AutoClusterFacesJobSchema.safeParse(job.data ?? {});
        if (!parsed.success) {
          log.warn({ issues: parsed.error.issues }, "auto-cluster-faces bad payload — ignoring");
          return null;
        }
        log.info({ workspaceId: parsed.data.workspaceId }, "auto-cluster-faces start");
        const result = await clusterWorkspaceFacesHNSW(parsed.data.workspaceId);
        log.info(result, "auto-cluster-faces complete");
        return result;
      }
      if (job.name === JobNames.AutoClusterScan) {
        // M5a (O4) — nightly sweep: enumerate every workspace with embedded,
        // non-hidden faces and fan one AutoClusterFaces job out to each. Same
        // enumeration the /api/v1/cron/auto-cluster route used (which relied
        // on a NAS cron that never existed); now fully worker-side.
        const parsed = AutoClusterScanJobSchema.safeParse(job.data ?? {});
        if (!parsed.success) {
          log.warn({ issues: parsed.error.issues }, "auto-cluster-scan bad payload — ignoring");
          return null;
        }
        const workspaces = await db
          .selectDistinct({ workspaceId: schema.faceInstances.workspaceId })
          .from(schema.faceInstances)
          .where(
            sql`${schema.faceInstances.hidden} = false
              AND ${schema.faceInstances.embedding} IS NOT NULL`
          );
        const enqueued: string[] = [];
        for (const { workspaceId } of workspaces) {
          const id = await addAutoClusterFacesJob({ workspaceId });
          if (id) enqueued.push(workspaceId);
        }
        log.info({ workspaces: enqueued.length }, "auto-cluster-scan complete");
        return { enqueued: enqueued.length };
      }
      log.warn({ name: job.name }, "unknown maintenance job — ignoring");
      return null;
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
      // The face-crop backfill is sharp-heavy and can briefly starve the event
      // loop past BullMQ's 30s default lock; give the maintenance worker the
      // same generous heavy lock the other CPU-bound workers use so a busy
      // batch doesn't get marked stalled + re-run.
      lockDuration: HEAVY_LOCK_DURATION_MS,
      stalledInterval: HEAVY_STALLED_INTERVAL_MS,
    }
  );

  w.on("failed", (job, err) =>
    logger.error(
      {
        queue: QueueNames.Maintenance,
        jobId: job?.id,
        name: job?.name,
        err: err.message,
      },
      "maintenance job failed"
    )
  );
  w.on("error", (err) =>
    logger.error({ queue: QueueNames.Maintenance, err: err.message }, "maintenance worker error")
  );

  return w;
}

/**
 * Register the recurring reaper schedule on the maintenance queue. Uses
 * BullMQ v5+'s `upsertJobScheduler` so re-running the worker boot is safe and
 * idempotent (re-applies the interval without duplicating the schedule).
 */
async function ensureReaperSchedule(): Promise<void> {
  await maintenanceQueue().upsertJobScheduler(
    JobNames.ReapStuckAssets,
    { every: REAPER_INTERVAL_MS },
    { name: JobNames.ReapStuckAssets }
  );
  logger.info(
    { intervalMs: REAPER_INTERVAL_MS, jobName: JobNames.ReapStuckAssets },
    "reaper schedule registered"
  );
}

/**
 * Phase 3.2 — register the daily audit-log retention sweep on the
 * maintenance queue. Same idempotent `upsertJobScheduler` pattern as the
 * stuck-asset reaper so re-running boot is safe.
 */
async function ensureAuditPruneSchedule(): Promise<void> {
  await maintenanceQueue().upsertJobScheduler(
    JobNames.PruneAuditLog,
    { every: AUDIT_PRUNE_INTERVAL_MS },
    { name: JobNames.PruneAuditLog }
  );
  logger.info(
    { intervalMs: AUDIT_PRUNE_INTERVAL_MS, jobName: JobNames.PruneAuditLog },
    "audit prune schedule registered"
  );
}

/**
 * Phase 7a — register the daily activity-digest dispatcher on the
 * maintenance queue. Same idempotent `upsertJobScheduler` pattern; safe
 * to re-run on boot.
 */
async function ensureDailyDigestSchedule(): Promise<void> {
  await maintenanceQueue().upsertJobScheduler(
    JobNames.DailyDigest,
    { every: DIGEST_INTERVAL_MS },
    { name: JobNames.DailyDigest }
  );
  logger.info(
    { intervalMs: DIGEST_INTERVAL_MS, jobName: JobNames.DailyDigest },
    "daily digest schedule registered"
  );
}

/** Phase 9.1 — nightly reconcile interval: 24 h (env-overridable for testing). */
const RECONCILE_INTERVAL_MS = (() => {
  const raw = process.env.RECONCILE_STORAGE_INTERVAL_MS;
  if (!raw) return 24 * 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24 * 60 * 60 * 1000;
})();

async function ensureStorageReconcileSchedule(): Promise<void> {
  await maintenanceQueue().upsertJobScheduler(
    JobNames.ReconcileStorageUsage,
    { every: RECONCILE_INTERVAL_MS },
    { name: JobNames.ReconcileStorageUsage }
  );
  logger.info(
    { intervalMs: RECONCILE_INTERVAL_MS, jobName: JobNames.ReconcileStorageUsage },
    "storage reconcile schedule registered"
  );
}

/**
 * Task 20 (Phase 3) — register the recurring auto-stacking sweep on the
 * maintenance queue. Same idempotent `upsertJobScheduler` pattern; safe to
 * re-run on boot. Reversible by design (sets stack_id only).
 */
async function ensureAutoStackSchedule(): Promise<void> {
  if (!AUTO_STACK_ENABLED) {
    // Disabled: actively remove any scheduler a prior boot registered, so
    // flipping the flag off stops the daily tick (upsert alone can't undo it).
    await maintenanceQueue().removeJobScheduler(JobNames.AutoStack);
    logger.info({ jobName: JobNames.AutoStack }, "auto-stack disabled (schedule removed)");
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.AutoStack,
    { every: AUTO_STACK_INTERVAL_MS },
    { name: JobNames.AutoStack }
  );
  logger.info(
    { intervalMs: AUTO_STACK_INTERVAL_MS, jobName: JobNames.AutoStack },
    "auto-stack schedule registered"
  );
}

/**
 * M5a (O4) — register the nightly auto-cluster sweep on the maintenance
 * queue. Same idempotent `upsertJobScheduler` pattern. The tick fans one
 * AutoClusterFaces job out to every workspace with face data, so the nightly
 * cluster run no longer depends on the NAS cron that never existed — this is
 * the operator-facing equivalent of the removed `/api/v1/cron/auto-cluster`
 * external trigger, worker-side.
 */
async function ensureAutoClusterSchedule(): Promise<void> {
  await maintenanceQueue().upsertJobScheduler(
    JobNames.AutoClusterScan,
    { every: AUTO_CLUSTER_INTERVAL_MS },
    { name: JobNames.AutoClusterScan }
  );
  logger.info(
    { intervalMs: AUTO_CLUSTER_INTERVAL_MS, jobName: JobNames.AutoClusterScan },
    "auto-cluster schedule registered"
  );
}

/**
 * Phase 1 (faces/UX) — register the recurring face-crop backfill on the
 * maintenance queue. DEFAULT-OFF: only registered when BACKFILL_FACE_CROPS is
 * truthy. When off we actively remove any scheduler a prior boot registered so
 * flipping the flag off stops the tick (upsert alone can't undo it). One-off
 * runs are always available via enqueueBackfillFaceCrops().
 */
async function ensureBackfillFaceCropsSchedule(): Promise<void> {
  if (!BACKFILL_FACE_CROPS_ENABLED) {
    await maintenanceQueue().removeJobScheduler(JobNames.BackfillFaceCrops);
    logger.info(
      { jobName: JobNames.BackfillFaceCrops },
      "face-crop backfill disabled (schedule removed)"
    );
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.BackfillFaceCrops,
    { every: BACKFILL_FACE_CROPS_INTERVAL_MS },
    {
      name: JobNames.BackfillFaceCrops,
      // Maintenance queue is typed with an empty payload; the backfill carries
      // a batchSize so cast through.
      data: { batchSize: BACKFILL_FACE_CROPS_BATCH_SIZE } as unknown as Record<
        string,
        never
      >,
    }
  );
  logger.info(
    {
      intervalMs: BACKFILL_FACE_CROPS_INTERVAL_MS,
      batchSize: BACKFILL_FACE_CROPS_BATCH_SIZE,
      jobName: JobNames.BackfillFaceCrops,
    },
    "face-crop backfill schedule registered"
  );
}

/**
 * Intelligence Core (Phase 3) — register the recurring evidence backfill on the
 * maintenance queue. DEFAULT-OFF: only registered when BACKFILL_EVIDENCE is
 * truthy. When off we actively remove any scheduler a prior boot registered so
 * flipping the flag off stops the tick. One-off runs are always available by
 * enqueueing JobNames.BackfillEvidence on the maintenance queue.
 */
async function ensureBackfillEvidenceSchedule(): Promise<void> {
  if (!BACKFILL_EVIDENCE_ENABLED) {
    await maintenanceQueue().removeJobScheduler(JobNames.BackfillEvidence);
    logger.info({ jobName: JobNames.BackfillEvidence }, "evidence backfill disabled (schedule removed)");
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.BackfillEvidence,
    { every: BACKFILL_EVIDENCE_INTERVAL_MS },
    {
      name: JobNames.BackfillEvidence,
      data: { batchSize: BACKFILL_EVIDENCE_BATCH_SIZE } as unknown as Record<string, never>,
    }
  );
  logger.info(
    {
      intervalMs: BACKFILL_EVIDENCE_INTERVAL_MS,
      batchSize: BACKFILL_EVIDENCE_BATCH_SIZE,
      jobName: JobNames.BackfillEvidence,
    },
    "evidence backfill schedule registered"
  );
}

/**
 * Intelligence Core (Phase 3) — register the recurring variant-candidate
 * recompute on the maintenance queue. DEFAULT-OFF (BACKFILL_VARIANT_CANDIDATES);
 * same remove-on-disable pattern.
 */
async function ensureVariantCandidatesSchedule(): Promise<void> {
  if (!VARIANT_CANDIDATES_ENABLED) {
    await maintenanceQueue().removeJobScheduler(JobNames.BackfillVariantCandidates);
    logger.info(
      { jobName: JobNames.BackfillVariantCandidates },
      "variant-candidate backfill disabled (schedule removed)"
    );
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.BackfillVariantCandidates,
    { every: VARIANT_CANDIDATES_INTERVAL_MS },
    { name: JobNames.BackfillVariantCandidates }
  );
  logger.info(
    {
      intervalMs: VARIANT_CANDIDATES_INTERVAL_MS,
      jobName: JobNames.BackfillVariantCandidates,
    },
    "variant-candidate backfill schedule registered"
  );
}

/**
 * Intelligence Core (Phase 4) — register the recurring inference backfill on the
 * maintenance queue. DEFAULT-OFF (BACKFILL_INFERENCE); same remove-on-disable
 * pattern as the Phase 3 sweeps.
 */
async function ensureBackfillInferenceSchedule(): Promise<void> {
  if (!BACKFILL_INFERENCE_ENABLED) {
    await maintenanceQueue().removeJobScheduler(JobNames.BackfillInference);
    logger.info({ jobName: JobNames.BackfillInference }, "inference backfill disabled (schedule removed)");
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.BackfillInference,
    { every: BACKFILL_INFERENCE_INTERVAL_MS },
    {
      name: JobNames.BackfillInference,
      data: { batchSize: BACKFILL_INFERENCE_BATCH_SIZE } as unknown as Record<string, never>,
    }
  );
  logger.info(
    {
      intervalMs: BACKFILL_INFERENCE_INTERVAL_MS,
      batchSize: BACKFILL_INFERENCE_BATCH_SIZE,
      jobName: JobNames.BackfillInference,
    },
    "inference backfill schedule registered"
  );
}

/**
 * Phase B5 — register the throttled mirror-backfill sweep. DEFAULT-OFF: only
 * registered when STORAGE_BACKFILL is truthy AND LOCAL_STORAGE_ROOT is set;
 * otherwise actively remove any scheduler a prior boot left so flipping the flag
 * off (or unmounting the share) stops the tick.
 */
async function ensureStorageMirrorBackfillSchedule(): Promise<void> {
  if (!STORAGE_BACKFILL_ENABLED) {
    await maintenanceQueue().removeJobScheduler(JobNames.BackfillStorageMirror);
    logger.info(
      { jobName: JobNames.BackfillStorageMirror },
      "storage-mirror backfill disabled (schedule removed)"
    );
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.BackfillStorageMirror,
    { every: STORAGE_BACKFILL_INTERVAL_MS },
    { name: JobNames.BackfillStorageMirror }
  );
  logger.info(
    { intervalMs: STORAGE_BACKFILL_INTERVAL_MS, jobName: JobNames.BackfillStorageMirror },
    "storage-mirror backfill schedule registered"
  );
}

/**
 * Phase B5 — register the nightly mirror-reconcile sweep. DEFAULT-OFF: same
 * gating as the backfill (STORAGE_RECONCILE truthy + LOCAL_STORAGE_ROOT set);
 * removes a stale scheduler when disabled.
 */
async function ensureStorageMirrorReconcileSchedule(): Promise<void> {
  if (!STORAGE_RECONCILE_ENABLED) {
    await maintenanceQueue().removeJobScheduler(JobNames.ReconcileStorageMirror);
    logger.info(
      { jobName: JobNames.ReconcileStorageMirror },
      "storage-mirror reconcile disabled (schedule removed)"
    );
    return;
  }
  await maintenanceQueue().upsertJobScheduler(
    JobNames.ReconcileStorageMirror,
    { every: STORAGE_RECONCILE_INTERVAL_MS },
    { name: JobNames.ReconcileStorageMirror }
  );
  logger.info(
    { intervalMs: STORAGE_RECONCILE_INTERVAL_MS, jobName: JobNames.ReconcileStorageMirror },
    "storage-mirror reconcile schedule registered"
  );
}

/**
 * Phase 9.1 — recompute usage_bytes for all workspaces from the live
 * assets table. Runs at most a few hundred workspaces; each UPDATE is
 * a single correlated sub-SELECT → safe in production load.
 */
async function reconcileStorageUsage(): Promise<{ workspacesUpdated: number }> {
  const { db, schema } = await import("@/lib/db");
  const { eq, sql, ne } = await import("drizzle-orm");
  const workspaces = await db.select({ id: schema.workspaces.id }).from(schema.workspaces);
  let updated = 0;
  for (const ws of workspaces) {
    const [row] = await db
      .select({ total: sql<string>`COALESCE(SUM(${schema.assets.sizeBytes}), 0)` })
      .from(schema.assets)
      .where(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql`${schema.assets.workspaceId} = ${ws.id} AND ${schema.assets.lifecycleState} != 'purged'`
      );
    const newUsage = Number(row?.total ?? 0);
    await db
      .update(schema.workspaces)
      .set({ usageBytes: newUsage })
      .where(eq(schema.workspaces.id, ws.id));
    updated++;
  }
  return { workspacesUpdated: updated };
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  // Stop accepting new jobs, wait for in-flight to finish (with timeout).
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  await closeRedisConnection();
  if (metricsServer) {
    await new Promise<void>((resolve) => {
      metricsServer?.close(() => resolve());
    });
  }
  logger.info("shutdown complete");
  process.exit(0);
}

async function main(): Promise<void> {
  // Boot OTel before constructing workers so http/pg/ioredis/bullmq spans
  // capture worker lifetime cleanly. No-op if OTEL_EXPORTER_OTLP_ENDPOINT
  // is unset.
  await startOtel("fonto-worker");

  logger.info(
    {
      concurrency: CONCURRENCY,
      thumbnailConcurrency: THUMBNAIL_CONCURRENCY,
      webhookConcurrency: WEBHOOK_CONCURRENCY,
      webhookTimeoutMs: WEBHOOK_TIMEOUT_MS,
      clipEmbedConcurrency: CLIP_EMBED_CONCURRENCY,
      clipDedupConcurrency: CLIP_DEDUP_CONCURRENCY,
      faceDetectConcurrency: FACE_DETECT_CONCURRENCY,
      importConcurrency: IMPORT_CONCURRENCY,
      metricsPort: METRICS_PORT,
      redisUrl: (process.env.REDIS_URL ?? "redis://valkey:6379").replace(/\/\/[^@]*@/, "//***@"),
    },
    "fonto worker starting"
  );

  startMetricsServer();
  workers.push(startAssetProcessingWorker());
  // Phase 1.1 — thumbnail derivatives. Separate worker so CPU-heavy sharp
  // encodes don't queue behind the umbrella processAsset pipeline.
  workers.push(startThumbnailWorker());
  workers.push(startStorageSyncWorker());

  // Maintenance worker + recurring reaper schedule. Registered after the
  // primary worker so a boot-time failure here doesn't block asset
  // processing — the reaper is belt-and-braces, not load-bearing.
  workers.push(startMaintenanceWorker());
  // Phase 2.4 — outbound webhook delivery.
  workers.push(startWebhookDeliveryWorker());
  // Phase 4.2 — CLIP image embeddings.
  workers.push(startClipEmbeddingWorker());
  // Phase 4.5 — CLIP-similarity dedup fallback consumer.
  workers.push(startClipDedupCheckWorker());
  // Phase 5.1 — face detection + ArcFace embedding.
  workers.push(startFaceDetectWorker());
  // Phase 8b — HLS ladder transcode + sprite (per-video, on demand).
  workers.push(startVideoHlsTranscodeWorker());
  // Phase 2 (media import) — Google Takeout / Amazon Photos archive import.
  workers.push(startImportWorker());
  // Intelligence Core (Phase 3) — per-asset date-evidence extraction.
  workers.push(startExtractEvidenceWorker());
  // Intelligence Core (Phase 4) — per-asset date fusion.
  workers.push(startInferDateWorker());
  try {
    await ensureReaperSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register reaper schedule — sweeps disabled until next boot"
    );
  }
  try {
    await ensureAuditPruneSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register audit prune schedule — retention disabled until next boot"
    );
  }
  try {
    await ensureDailyDigestSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register daily digest schedule — digests disabled until next boot"
    );
  }
  try {
    await ensureStorageReconcileSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register storage reconcile schedule — drift correction disabled until next boot"
    );
  }
  try {
    await ensureAutoStackSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register auto-stack schedule — auto-stacking disabled until next boot"
    );
  }
  try {
    await ensureAutoClusterSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register auto-cluster schedule — auto-cluster disabled until next boot"
    );
  }
  try {
    await ensureBackfillFaceCropsSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register face-crop backfill schedule — backfill off until next boot"
    );
  }
  try {
    await ensureStorageMirrorBackfillSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register storage-mirror backfill schedule — backfill off until next boot"
    );
  }
  try {
    await ensureStorageMirrorReconcileSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register storage-mirror reconcile schedule — reconcile off until next boot"
    );
  }
  try {
    await ensureBackfillEvidenceSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register evidence backfill schedule — backfill off until next boot"
    );
  }
  try {
    await ensureVariantCandidatesSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register variant-candidate backfill schedule — backfill off until next boot"
    );
  }
  try {
    await ensureBackfillInferenceSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register inference backfill schedule — backfill off until next boot"
    );
  }

  // Future: register thumbnail / classify / ocr-only workers here once their
  // pipelines are split out of the all-in-one processAsset function.

  // ponytail: setInterval drift sweep; upgrade to maintenanceQueue scheduler if exact 4am timing matters
  setTimeout(() => void runDriftSweep(), 5 * 60_000);
  setInterval(() => void runDriftSweep(), 24 * 60 * 60_000);

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) =>
    logger.error({ reason: String(reason) }, "unhandled rejection")
  );
  process.on("uncaughtException", (err) =>
    logger.fatal({ err: err.message }, "uncaught exception")
  );
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "worker boot failed");
  process.exit(1);
});
