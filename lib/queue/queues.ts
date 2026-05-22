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
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
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

/** Iterate all queues (handy for bull-board, graceful shutdown, metrics). */
export function allQueues(): Queue[] {
  // Touch each accessor so the cache is populated before we read .values().
  assetProcessingQueue();
  ocrQueue();
  thumbnailQueue();
  classifyQueue();
  return Array.from(cache.values());
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(cache.values()).map((q) => q.close().catch(() => undefined)));
  cache.clear();
}
