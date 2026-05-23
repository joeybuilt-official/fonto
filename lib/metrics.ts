// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Prometheus metrics registry for Fonto. A single shared `prom-client`
// Registry is exported and re-used by both the Next.js app (via the
// `/api/metrics` route) and the worker container (via its own tiny HTTP
// listener in `worker/index.ts`).
//
// Edge runtime safety: this module pulls in `prom-client` (Node-only) plus
// `bullmq`/`ioredis` for the queue-depth gauge updater. The `/api/metrics`
// route pins itself to `runtime = 'nodejs'`; the gauge updater additionally
// guards on `process.env.NEXT_RUNTIME !== 'edge'` so accidental edge imports
// stay inert.

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

/**
 * Shared registry. We construct a fresh `Registry` instead of using the
 * library's global `register` so multiple Fonto instances in the same
 * process (tests, hot-reload) stay isolated and `collectDefaultMetrics`
 * never throws "already registered".
 */
export const register = new Registry();

// Node process metrics (cpu, heap, event-loop lag, etc.) — prefixed so they
// don't collide with any sibling app's metrics on the same Prometheus.
collectDefaultMetrics({ register, prefix: "fonto_" });

/**
 * HTTP request duration. Instrumented from API routes that want explicit
 * latency tracking (e.g. the asset upload endpoint). Auto-instrumentation
 * via OpenTelemetry captures trace-level timing separately; this histogram
 * is the Prom-native view.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "fonto_http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method/route/status_code.",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

/**
 * Post-upload processing pipeline duration. Observed in
 * `lib/processing/processAsset.ts` around the full pipeline.
 *
 * Phase 4.6 added the `classify_method` label so we can compare the cheap
 * CLIP path (≈free, ms-scale) against the LLM-fallback path (~$0.001 +
 * ~1-3s). `skip` covers non-image assets and the pre-CLIP-vec early-out.
 */
export const assetProcessingDurationSeconds = new Histogram({
  name: "fonto_asset_processing_duration_seconds",
  help:
    "Asset processing pipeline duration in seconds, labeled by outcome and classify_method.",
  labelNames: ["outcome", "classify_method"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

/**
 * Phase 4.6 — distribution of CLIP top-1 cosine scores. We sample every
 * classify attempt (including ones that ended up taking the LLM fallback).
 * Useful for tuning `CLASSIFY_CONFIDENCE_THRESHOLD`: if the bulk of the
 * mass sits below the threshold we know we're throwing too many cases at
 * the LLM. Buckets bias toward the low end since CLIP image+text cosine
 * rarely exceeds 0.3.
 */
export const zeroShotConfidenceBuckets = new Histogram({
  name: "fonto_zero_shot_confidence_buckets",
  help: "Distribution of zero-shot CLIP top-1 cosine confidence scores.",
  buckets: [0.05, 0.1, 0.15, 0.18, 0.2, 0.22, 0.25, 0.3, 0.4, 0.5],
  registers: [register],
});

/**
 * Current queue depth per BullMQ queue. Updated by a setInterval below.
 * Labelled `queue` so a single time series per queue name lands in Prom.
 */
export const assetProcessingQueueDepth = new Gauge({
  name: "fonto_asset_processing_queue_depth",
  help: "Current BullMQ queue depth (waiting + delayed) per queue.",
  labelNames: ["queue"] as const,
  registers: [register],
});

/**
 * Total assets ingested, partitioned by MIME class. The label is a coarse
 * bucket (image | video | document | other) rather than the raw MIME type
 * so cardinality stays bounded.
 */
export const assetIngestTotal = new Counter({
  name: "fonto_asset_ingest_total",
  help: "Total assets ingested via the upload endpoint, by MIME class.",
  labelNames: ["mime_class"] as const,
  registers: [register],
});

/** Coarse MIME bucketer. Public so the API route can compute the label. */
export function classifyMime(
  mimeType: string | null | undefined
): "image" | "video" | "document" | "other" {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType.includes("officedocument") ||
    mimeType.includes("msword") ||
    mimeType.includes("spreadsheet")
  ) {
    return "document";
  }
  return "other";
}

// ── Queue depth updater ─────────────────────────────────────────────────────
//
// A single setInterval keeps the gauge fresh. Guarded against:
//   1. Edge runtime — we MUST NOT load bullmq/ioredis there.
//   2. Next.js dev hot-reload — module re-evaluation must not stack intervals.
//
// We pin the timer to `globalThis.__fontoMetricsInterval` so re-import is a
// no-op. Same trick a lot of Next.js examples use for singletons across HMR.

const POLL_INTERVAL_MS = 10_000;

interface FontoMetricsGlobals {
  __fontoMetricsInterval?: NodeJS.Timeout;
}
const g = globalThis as unknown as FontoMetricsGlobals;

function startQueueDepthPoller(): void {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (g.__fontoMetricsInterval) return;

  const tick = async (): Promise<void> => {
    try {
      // Lazy import keeps bullmq/ioredis off the edge bundle and avoids a
      // Redis socket at module-eval time on the server. The queue handles
      // also lazy-construct their underlying ioredis connection, so a poll
      // when REDIS_URL is unreachable just logs and skips.
      const { allQueues } = await import("./queue/queues");
      const queues = allQueues();
      await Promise.all(
        queues.map(async (q) => {
          try {
            const counts = await q.getJobCounts(
              "waiting",
              "active",
              "delayed",
              "failed",
              "completed"
            );
            const depth =
              (counts.waiting ?? 0) +
              (counts.active ?? 0) +
              (counts.delayed ?? 0);
            assetProcessingQueueDepth.labels({ queue: q.name }).set(depth);
          } catch {
            // Single-queue failure shouldn't take down the whole poll.
          }
        })
      );
    } catch {
      // Silent — the gauge simply stays at its prior value until the next
      // tick succeeds.
    }
  };

  // Kick off an immediate tick so the first scrape after boot has data,
  // then run on the interval. `unref()` prevents the timer from pinning
  // the event loop open during shutdown.
  void tick();
  const handle = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  handle.unref?.();
  g.__fontoMetricsInterval = handle;
}

startQueueDepthPoller();

/**
 * Stop the queue-depth poller. Exported for tests and the worker shutdown
 * sequence; calling it in production is harmless.
 */
export function stopQueueDepthPoller(): void {
  if (g.__fontoMetricsInterval) {
    clearInterval(g.__fontoMetricsInterval);
    g.__fontoMetricsInterval = undefined;
  }
}
