// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Typed BullMQ queue handles. Producers (the Next.js API routes) import these
// to `add()` jobs; the worker (worker/index.ts) constructs `Worker` instances
// against the same names.

import { Queue, type JobsOptions } from "bullmq";
import { getRedisConnection } from "./connection";
import type {
  ProcessAssetJob,
  OcrJob,
  ThumbnailJob,
  ClassifyJob,
  ClipDedupCheckJob,
  WebhookDeliveryJob,
  EmbedAssetJob,
} from "./jobs";

export const QueueNames = {
  AssetProcessing: "asset-processing",
  Ocr: "ocr",
  // Phase 1.1 — queue name is plural ("thumbnails") so BullMQ's per-queue
  // Redis key prefix doesn't collide with the legacy singular handle.
  Thumbnail: "thumbnails",
  Classify: "classify",
  // Maintenance queue hosts low-frequency housekeeping jobs (e.g. the
  // reap-stuck-assets sweep). Kept on its own queue so its single-concurrency
  // worker never contends with asset-processing throughput.
  Maintenance: "maintenance",
  // Phase 2.4 — outbound webhook delivery. Retries are managed at the
  // application level (we re-enqueue with `delay` based on attempt number)
  // so we use a low BullMQ-level `attempts` value.
  WebhookDelivery: "webhook-delivery",
  // Phase 4.2 — CLIP image embedding. Network-bound (POST to plexo-vision).
  // Separate queue so vision-service outages don't backlog the asset
  // processing pipeline.
  ClipEmbedding: "clip-embedding",
  // Phase 4.5 — CLIP-similarity dedup check. Low priority, second-pass
  // after pHash. Distinct from the asset-processing queue so a slow vision
  // service call never delays the main pipeline.
  ClipDedupCheck: "clip-dedup-check",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/**
 * Maintenance jobs are intentionally not retried with the asset-processing
 * backoff curve — they're idempotent sweeps that the next scheduler tick will
 * re-run anyway. One attempt, fail fast, keep a small trace history.
 */
const maintenanceJobOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: 100,
  removeOnFail: 100,
};

/**
 * Lazy queue cache. We construct queues on first access so importing
 * `lib/queue/queues` from the Next.js edge runtime (or at build time) doesn't
 * eagerly open a Redis socket.
 */
const cache = new Map<string, Queue>();

function getOrCreate<T>(name: string): Queue<T> {
  const existing = cache.get(name);
  if (existing) return existing as Queue<T>;
  const q = new Queue<T>(name, {
    connection: getRedisConnection(),
    defaultJobOptions,
  });
  cache.set(name, q);
  return q;
}

export function assetProcessingQueue(): Queue<ProcessAssetJob> {
  return getOrCreate<ProcessAssetJob>(QueueNames.AssetProcessing);
}

export function ocrQueue(): Queue<OcrJob> {
  return getOrCreate<OcrJob>(QueueNames.Ocr);
}

export function thumbnailQueue(): Queue<ThumbnailJob> {
  return getOrCreate<ThumbnailJob>(QueueNames.Thumbnail);
}

export function classifyQueue(): Queue<ClassifyJob> {
  return getOrCreate<ClassifyJob>(QueueNames.Classify);
}

/**
 * Maintenance queue handle. Hosts the periodic `reap-stuck-assets` job and
 * future housekeeping schedulers. Payloads are empty — the handler reads the
 * world from Postgres on each tick.
 *
 * Uses `maintenanceJobOptions` (attempts: 1) since these jobs are idempotent
 * sweeps that the scheduler will re-run on the next tick anyway.
 */
/**
 * Webhook delivery queue. Retries are handled by the worker (it re-enqueues
 * with an explicit `delay` calculated from the row's `attempts` count), so
 * BullMQ-level `attempts` stays at 1 — a BullMQ retry would lose the
 * exponential-backoff schedule we encode in the row's `nextAttemptAt`.
 */
export function webhookDeliveryQueue(): Queue<WebhookDeliveryJob> {
  const name = QueueNames.WebhookDelivery;
  const existing = cache.get(name);
  if (existing) return existing as Queue<WebhookDeliveryJob>;
  const q = new Queue<WebhookDeliveryJob>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });
  cache.set(name, q);
  return q;
}

/**
 * Phase 4.2 — CLIP embedding queue. Defaults to 3 attempts with exponential
 * backoff (vision service hiccups are common; one retry usually unsticks).
 * Concurrency is controlled by the worker via CLIP_EMBED_CONCURRENCY env.
 */
export function clipEmbeddingQueue(): Queue<EmbedAssetJob> {
  const name = QueueNames.ClipEmbedding;
  const existing = cache.get(name);
  if (existing) return existing as Queue<EmbedAssetJob>;
  const q = new Queue<EmbedAssetJob>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  });
  cache.set(name, q);
  return q;
}

/**
 * Phase 4.5 — CLIP-similarity dedup check queue. Jobs are tiny `{ assetId,
 * workspaceId }` payloads; the worker reads the clip_vec from Postgres at
 * run time. Re-enqueueing with a delay is the worker's strategy for "the
 * embedding hasn't been computed yet" — keep `attempts` modest so a
 * truly broken row doesn't spin forever.
 */
export function clipDedupCheckQueue(): Queue<ClipDedupCheckJob> {
  const name = QueueNames.ClipDedupCheck;
  const existing = cache.get(name);
  if (existing) return existing as Queue<ClipDedupCheckJob>;
  const q = new Queue<ClipDedupCheckJob>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 100,
    },
  });
  cache.set(name, q);
  return q;
}

export function maintenanceQueue(): Queue<Record<string, never>> {
  const name = QueueNames.Maintenance;
  const existing = cache.get(name);
  if (existing) return existing as Queue<Record<string, never>>;
  const q = new Queue<Record<string, never>>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: maintenanceJobOptions,
  });
  cache.set(name, q);
  return q;
}

/** Iterate all queues (handy for bull-board, graceful shutdown, metrics). */
export function allQueues(): Queue[] {
  // Touch each accessor so the cache is populated before we read .values().
  assetProcessingQueue();
  ocrQueue();
  thumbnailQueue();
  classifyQueue();
  maintenanceQueue();
  webhookDeliveryQueue();
  clipEmbeddingQueue();
  clipDedupCheckQueue();
  return Array.from(cache.values());
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(cache.values()).map((q) => q.close().catch(() => undefined)));
  cache.clear();
}
