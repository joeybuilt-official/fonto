// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Typed BullMQ queue handles. Producers (the Next.js API routes) import these
// to `add()` jobs; the worker (worker/index.ts) constructs `Worker` instances
// against the same names.

import { Queue, type JobsOptions } from "bullmq";
import { getRedisConnection } from "./connection";
import { JobNames } from "./jobs";
import type {
  ProcessAssetJob,
  OcrJob,
  ThumbnailJob,
  ClipDedupCheckJob,
  WebhookDeliveryJob,
  EmbedAssetJob,
  FaceDetectJob,
  VideoHlsTranscodeJob,
  ImportJob,
  StorageSyncJob,
  ExtractEvidenceJob,
  InferDateJob,
  BackfillReconcileJob,
  AutoClusterFacesJob,
} from "./jobs";

export const QueueNames = {
  AssetProcessing: "asset-processing",
  Ocr: "ocr",
  // Phase 1.1 — queue name is plural ("thumbnails") so BullMQ's per-queue
  // Redis key prefix doesn't collide with the legacy singular handle.
  Thumbnail: "thumbnails",
  // Maintenance queue hosts low-frequency housekeeping jobs (e.g. the
  // reap-stuck-assets sweep). Kept on its own queue so its single-concurrency
  // worker never contends with asset-processing throughput.
  Maintenance: "maintenance",
  // Phase 2.4 — outbound webhook delivery. Retries are managed at the
  // application level (we re-enqueue with `delay` based on attempt number)
  // so we use a low BullMQ-level `attempts` value.
  WebhookDelivery: "webhook-delivery",
  // Phase 4.2 — CLIP image embedding. Network-bound (POST to the vision sidecar).
  // Separate queue so vision-service outages don't backlog the asset
  // processing pipeline.
  ClipEmbedding: "clip-embedding",
  // Phase 4.5 — CLIP-similarity dedup check. Low priority, second-pass
  // after pHash. Distinct from the asset-processing queue so a slow vision
  // service call never delays the main pipeline.
  ClipDedupCheck: "clip-dedup-check",
  // Phase 5.1 — face detection + ArcFace embedding. Separate queue so a
  // sidecar outage on /v1/faces/detect doesn't backlog the CLIP queue.
  FaceDetect: "face-detect",
  // Phase 8b — HLS ladder transcode. Heavy CPU + I/O job; isolated so
  // a flood of new-video uploads doesn't drown asset-processing.
  VideoHlsTranscode: "video-hls-transcode",
  // Phase 0 (media import) — Google Takeout / Amazon Photos archive import.
  // Long-running, streaming, app-managed resume; isolated on its own queue so
  // a multi-GB import never backlogs the asset-processing pipeline.
  Import: "media-import",
  // Phase B3 (storage placement) — mirror an asset's original R2→local for
  // `mirror`-policy workspaces. I/O-bound (R2 download + local write); own queue
  // so a large-file mirror never backlogs asset-processing.
  StorageSync: "storage-sync",
  // Intelligence Core (Phase 3) — per-asset date-evidence extraction. Mostly
  // Postgres-bound + one optional vision label call; own queue so a vision
  // hiccup doesn't backlog the main pipeline.
  ExtractEvidence: "extract-evidence",
  // Intelligence Core (Phase 4) — per-asset date fusion. Pure CPU + 2 small
  // Postgres reads + 1 upsert; own queue so it never blocks ingest.
  InferDate: "infer-date",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  // Bounded, not immortal. BullMQ refuses an `add` whose jobId already exists
  // in ANY set — including `failed` — so an unbounded failed set combined with
  // the pinned jobIds the producers now use (reap-<id>, process-<id>) would let
  // one failed job block that asset from ever being re-enqueued. Keep the last
  // 1000 for diagnosis; older failures age out.
  removeOnFail: 1000,
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

/**
 * Phase B3 (storage placement) — mirror-sync queue. One job per asset whose
 * effective policy is `mirror`; the handler streams the original R2→local and
 * stamps assets.local_original_stored_at after a verified copy.
 */
export function storageSyncQueue(): Queue<StorageSyncJob> {
  return getOrCreate<StorageSyncJob>(QueueNames.StorageSync);
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

/**
 * Phase 5.1 — face detection + ArcFace embedding queue. Network-bound (POST
 * to the vision sidecar /v1/faces/detect). Concurrency is controlled by the
 * worker via FACE_DETECT_CONCURRENCY env (default 2).
 *
 * Jobs include both the detection pass (RetinaFace or equivalent) and the
 * 512-dim embedding pass — the sidecar batches both behind a single call.
 * If the sidecar is unconfigured the worker no-ops with a skip reason.
 */
export function faceDetectQueue(): Queue<FaceDetectJob> {
  const name = QueueNames.FaceDetect;
  const existing = cache.get(name);
  if (existing) return existing as Queue<FaceDetectJob>;
  const q = new Queue<FaceDetectJob>(name, {
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
 * Enqueue a face-detect job for an asset. Thin wrapper that lets producers
 * stay decoupled from the queue handle (and dodge an explicit import in
 * dynamic-import sites like `lib/assets/createAssetRow.ts`). Fire-and-forget;
 * the worker reads everything else from Postgres/R2.
 */
export async function addFaceDetectJob(payload: FaceDetectJob): Promise<void> {
  await faceDetectQueue().add("face-detect", payload);
}

/**
 * Phase 8b — HLS ladder transcode queue. CPU-bound; concurrency low by
 * default (one transcode at a time). Single attempt — failures flip the
 * row's hls_state to 'failed' and the user can retry via re-issuing the
 * /hls endpoint.
 */
export function videoHlsTranscodeQueue(): Queue<VideoHlsTranscodeJob> {
  const name = QueueNames.VideoHlsTranscode;
  const existing = cache.get(name);
  if (existing) return existing as Queue<VideoHlsTranscodeJob>;
  const q = new Queue<VideoHlsTranscodeJob>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 200,
    },
  });
  cache.set(name, q);
  return q;
}

export async function addVideoHlsTranscodeJob(payload: VideoHlsTranscodeJob): Promise<void> {
  // Job name = JobNames.VideoHlsTranscode (string literal kept in sync
  // via the const map in jobs.ts).
  await videoHlsTranscodeQueue().add("video-hls-transcode", payload);
}

/**
 * Phase 0 (media import) — Google Takeout / Amazon Photos archive import
 * queue. Single attempt: imports are long-running and resume is app-managed
 * via the `import_jobs.cursor` checkpoint, so a BullMQ retry would wastefully
 * restart the whole archive instead of resuming. The worker (Phase 2/3) reads
 * the import_jobs row + cursor from Postgres on start.
 */
export function importQueue(): Queue<ImportJob> {
  const name = QueueNames.Import;
  const existing = cache.get(name);
  if (existing) return existing as Queue<ImportJob>;
  const q = new Queue<ImportJob>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  });
  cache.set(name, q);
  return q;
}

/**
 * Enqueue a media-import job. Thin wrapper mirroring the other producer
 * helpers so API routes (Phase 1/3) stay decoupled from the queue handle.
 * Job name = JobNames.Import ("media-import").
 */
export async function tryEnqueueImport(payload: ImportJob): Promise<void> {
  await importQueue().add("media-import", payload);
}

/**
 * Intelligence Core (Phase 3) — per-asset evidence extraction queue. Tiny
 * payloads; the worker reads the asset from Postgres + presigns the preview for
 * the optional scene-label call. 3 attempts with backoff (a transient vision /
 * presign hiccup usually clears on retry); the Fonto-local adapters are
 * deterministic so a retry re-derives the same rows idempotently.
 */
export function extractEvidenceQueue(): Queue<ExtractEvidenceJob> {
  const name = QueueNames.ExtractEvidence;
  const existing = cache.get(name);
  if (existing) return existing as Queue<ExtractEvidenceJob>;
  const q = new Queue<ExtractEvidenceJob>(name, {
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

/** Enqueue an extract-evidence job. Fire-and-forget; never throws, only logs. */
export async function addExtractEvidenceJob(payload: ExtractEvidenceJob): Promise<void> {
  try {
    await extractEvidenceQueue().add(JobNames.ExtractEvidence, payload);
  } catch (err) {
    console.warn("[fonto] extract-evidence enqueue skipped:", err);
  }
}

/**
 * Intelligence Core (Phase 4) — date-fusion queue. Tiny payloads; the worker
 * reads the asset's evidence rows + stored captured_at and upserts one
 * inference proposal. CPU-light + idempotent, so a retry re-fuses to the same
 * proposal.
 */
export function inferDateQueue(): Queue<InferDateJob> {
  const name = QueueNames.InferDate;
  const existing = cache.get(name);
  if (existing) return existing as Queue<InferDateJob>;
  const q = new Queue<InferDateJob>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3_000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  });
  cache.set(name, q);
  return q;
}

/** Enqueue an infer-date job. Fire-and-forget; never throws, only logs. */
export async function addInferDateJob(payload: InferDateJob): Promise<void> {
  try {
    await inferDateQueue().add(JobNames.InferDate, payload);
  } catch (err) {
    console.warn("[fonto] infer-date enqueue skipped:", err);
  }
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

/**
 * Intelligence Core (Phase 8) — enqueue the one-off, operator-gated date
 * reconcile on the maintenance queue with a typed payload. The maintenance
 * queue is heterogeneous (declared as Record<string,never>); this helper is the
 * typed door for the BackfillReconcile job specifically.
 */
export async function addBackfillReconcileJob(
  payload: BackfillReconcileJob,
  opts: { jobId?: string } = {}
): Promise<string | undefined> {
  const q = maintenanceQueue() as unknown as Queue<BackfillReconcileJob>;
  const job = await q.add(JobNames.BackfillReconcile, payload, {
    jobId: opts.jobId,
    removeOnComplete: true,
    removeOnFail: 50,
  });
  return job.id;
}

/** Iterate all queues (handy for bull-board, graceful shutdown, metrics). */
export function allQueues(): Queue[] {
  // Touch each accessor so the cache is populated before we read .values().
  assetProcessingQueue();
  ocrQueue();
  thumbnailQueue();
  maintenanceQueue();
  webhookDeliveryQueue();
  clipEmbeddingQueue();
  clipDedupCheckQueue();
  faceDetectQueue();
  videoHlsTranscodeQueue();
  importQueue();
  storageSyncQueue();
  extractEvidenceQueue();
  inferDateQueue();
  return Array.from(cache.values());
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(cache.values()).map((q) => q.close().catch(() => undefined)));
  cache.clear();
}

/**
 * M15 closeout — enqueue one nightly HNSW face auto-cluster job for a workspace.
 */
export async function addAutoClusterFacesJob(
  payload: AutoClusterFacesJob
): Promise<string | undefined> {
  const q = maintenanceQueue() as unknown as Queue<AutoClusterFacesJob>;
  const job = await q.add(JobNames.AutoClusterFaces, payload, {
    jobId: `auto-cluster-faces-${payload.workspaceId}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
  return job.id;
}
