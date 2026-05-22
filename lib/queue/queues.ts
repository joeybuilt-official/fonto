// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Typed BullMQ queue handles. Producers (the Next.js API routes) import these
// to `add()` jobs; the worker (worker/index.ts) constructs `Worker` instances
// against the same names.

import { Queue, type JobsOptions } from "bullmq";
import { getRedisConnection } from "./connection";
import type { ProcessAssetJob, OcrJob, ThumbnailJob, ClassifyJob } from "./jobs";

export const QueueNames = {
  AssetProcessing: "asset-processing",
  Ocr: "ocr",
  Thumbnail: "thumbnail",
  Classify: "classify",
  // Maintenance queue hosts low-frequency housekeeping jobs (e.g. the
  // reap-stuck-assets sweep). Kept on its own queue so its single-concurrency
  // worker never contends with asset-processing throughput.
  Maintenance: "maintenance",
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
  return Array.from(cache.values());
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(cache.values()).map((q) => q.close().catch(() => undefined)));
  cache.clear();
}
