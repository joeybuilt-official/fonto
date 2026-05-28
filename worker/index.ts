// SPDX-License-Identifier: AGPL-3.0-only
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
  type ProcessAssetJob,
  type GenerateThumbnailsJob,
  type WebhookDeliveryJob,
  type EmbedAssetJob,
  type ClipDedupCheckJob,
  type FaceDetectJob,
  type VideoHlsTranscodeJob,
} from "@/lib/queue/jobs";
import { nearestNeighbors } from "@/lib/vectors";
import { signWebhookPayload } from "@/lib/webhooks/emit";
import { processAsset } from "@/lib/processing/processAsset";
import { reapStuckAssets } from "@/lib/processing/reapStuckAssets";
import { generateThumbnails } from "@/lib/processing/generateThumbnails";
import { embedAsset } from "@/lib/processing/embedAsset";
import { detectFacesForAsset } from "@/lib/processing/detectFaces";
import { pruneAuditLog } from "@/lib/maintenance/auditPrune";
import { runDailyDigest } from "@/lib/notifications/runDailyDigest";
import { transcodeVideoHls } from "@/lib/processing/transcodeVideoHls";
import { generateSpriteSheet } from "@/lib/processing/generateSpriteSheet";
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
// Phase 4.5 — re-enqueue delay when the embedding isn't yet present on the
// row (the upstream CLIP-embed job from Phase 4.2 hasn't completed). We don't
// fail the job because there's nothing wrong; we just wait and try again.
const CLIP_DEDUP_RETRY_DELAY_MS = Math.max(
  parseInt(process.env.CLIP_DEDUP_RETRY_DELAY_MS ?? "30000", 10),
  1000
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
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, "asset processing failed");
        await db
          .update(schema.assets)
          .set({
            processingError: msg.slice(0, 1000),
            // Mirror the legacy fire-and-forget behaviour: on terminal
            // failure the row falls back to 'captured' so a future manual
            // re-enqueue can pick it up.
            processingState: "captured",
          })
          .where(eq(schema.assets.id, data.assetId))
          .catch(() => undefined);
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: CONCURRENCY,
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

      log.info("generating thumbnails");
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
    },
    {
      connection: getRedisConnection(),
      concurrency: THUMBNAIL_CONCURRENCY,
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

      type ClipVecRow = { clip_vec: number[] | null; lifecycle_state: string };
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
        log.info("clip_vec not yet populated; re-enqueuing");
        await clipDedupCheckQueue().add(
          JobNames.ClipDedupCheck,
          { assetId, workspaceId },
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
        let durationSec = asset.durationSeconds ?? null;
        let srcW = asset.videoWidth ?? null;
        let srcH = asset.videoHeight ?? null;
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
      log.warn({ name: job.name }, "unknown maintenance job — ignoring");
      return null;
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
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

  // Future: register thumbnail / classify / ocr-only workers here once their
  // pipelines are split out of the all-in-one processAsset function.

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
