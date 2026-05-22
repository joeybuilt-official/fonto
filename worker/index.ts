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
  QueueNames,
  JobNames,
  closeAllQueues,
  ProcessAssetJobSchema,
  GenerateThumbnailsJobSchema,
  maintenanceQueue,
  type ProcessAssetJob,
  type GenerateThumbnailsJob,
} from "@/lib/queue";
import { processAsset, reapStuckAssets, generateThumbnails } from "@/lib/processing";
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
const METRICS_PORT = Math.max(parseInt(process.env.WORKER_METRICS_PORT ?? "9464", 10), 1);

// Reaper scheduler tick in milliseconds. Default 5 minutes. Configurable so
// integration tests can dial it down to seconds without code changes.
const REAPER_INTERVAL_MS = Math.max(
  parseInt(process.env.REAPER_INTERVAL_MS ?? `${5 * 60 * 1000}`, 10),
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
  try {
    await ensureReaperSchedule();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to register reaper schedule — sweeps disabled until next boot"
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
