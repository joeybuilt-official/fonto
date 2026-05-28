// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Zod schemas + TS types for every BullMQ job payload Fonto enqueues. Each
// schema doubles as a runtime validator inside the worker so a malformed
// payload never crashes the process — it's logged and the job is marked
// failed by the worker handler.

import { z } from "zod";

export const ProcessAssetJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string(),
  email: z.string().optional(),
  filename: z.string(),
  mimeType: z.string(),
  extractedText: z.string().nullable().optional(),
});
export type ProcessAssetJob = z.infer<typeof ProcessAssetJobSchema>;

export const OcrJobSchema = z.object({
  assetId: z.string().uuid(),
  plexoWorkspaceId: z.string(),
});
export type OcrJob = z.infer<typeof OcrJobSchema>;

export const ThumbnailJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type ThumbnailJob = z.infer<typeof ThumbnailJobSchema>;

// Phase 1.1 — thumbnail generation job payload. Currently shaped identically
// to `ThumbnailJobSchema` (re-exported as the canonical Phase 1.1 alias) so
// producers and the worker agree on the same struct. Kept as its own export
// so future variant lists / regeneration flags can extend it without touching
// other consumers.
export const GenerateThumbnailsJobSchema = ThumbnailJobSchema;
export type GenerateThumbnailsJob = z.infer<typeof GenerateThumbnailsJobSchema>;

export const ClassifyJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type ClassifyJob = z.infer<typeof ClassifyJobSchema>;

// Phase 4.2 — CLIP image embedding job. The worker downloads the asset's
// preview derivative (or original if preview missing), POSTs to the Plexo
// vision service, and writes the returned 512-dim float vector to
// `assets.clip_vec` (lands with the 4.3 pgvector migration). Payload stays
// tiny — the worker rehydrates everything else from Postgres.
export const EmbedAssetJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type EmbedAssetJob = z.infer<typeof EmbedAssetJobSchema>;

// Maintenance: periodic sweep that re-enqueues or terminally fails any asset
// row stuck in processing_state='processing' past the threshold. Payload is
// empty — the reaper reads the world from Postgres on each tick.
export const ReapStuckAssetsJobSchema = z.object({}).strict();
export type ReapStuckAssetsJob = z.infer<typeof ReapStuckAssetsJobSchema>;

// Phase 3.2 — audit_log retention reaper. Empty payload; the reaper reads
// AUDIT_RETENTION_DAYS at tick time so an env change propagates without a
// scheduler re-register.
export const PruneAuditLogJobSchema = z.object({}).strict();
export type PruneAuditLogJob = z.infer<typeof PruneAuditLogJobSchema>;

// Phase 4.5 — CLIP-similarity second-pass dedup check. Enqueued when the
// inline embed in `createAssetRow()` exceeds CLIP_DEDUP_INLINE_TIMEOUT_MS,
// or as a backfill from `scripts/scan-clip-duplicates.ts`. Tiny payload:
// the worker reads the asset row + clip_vec from Postgres at run time.
export const ClipDedupCheckJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type ClipDedupCheckJob = z.infer<typeof ClipDedupCheckJobSchema>;

// Phase 2.4 — outbound webhook delivery. Payload references a row in
// fonto.webhook_deliveries; the worker rehydrates everything else from
// Postgres so the job stays tiny + crash-safe.
export const WebhookDeliveryJobSchema = z.object({
  deliveryId: z.string().uuid(),
  // Attempt number this job represents. The worker also reads the row's
  // current `attempts` column — this field is for log/debug parity and is
  // 1-indexed for legibility (first attempt = 1).
  attempt: z.number().int().min(1),
});
export type WebhookDeliveryJob = z.infer<typeof WebhookDeliveryJobSchema>;

// Phase 5.1 — face detection + ArcFace embedding job. Payload is tiny: the
// worker reads the asset (and its thumbnail derivative) from Postgres/R2 at
// run time, posts to the Plexo vision sidecar, and inserts
// `fonto.face_instances` rows.
export const FaceDetectJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type FaceDetectJob = z.infer<typeof FaceDetectJobSchema>;

// Phase 8b — on-demand HLS ladder transcode (+ sprite). Triggered by
// the first /api/v1/assets/:id/hls request when hls_state='idle'.
// Worker downloads source from R2, runs the ffmpeg ladder, uploads
// renditions + master playlist + sprite, and flips hls_state to
// 'ready'. Single-flight via the row's hls_state column — the API
// handler only enqueues when state is 'idle' (or 'failed' on retry).
export const VideoHlsTranscodeJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type VideoHlsTranscodeJob = z.infer<typeof VideoHlsTranscodeJobSchema>;

// Phase 7a — daily activity digest. Iterates every (workspaceMember,
// workspace) pair, computes the events since their last digest cursor
// (skipping muted scopes), and dispatches one email per member with
// content. Empty payload — the worker reads the world from Postgres on
// each tick.
export const DailyDigestJobSchema = z.object({}).strict();
export type DailyDigestJob = z.infer<typeof DailyDigestJobSchema>;

// Phase 9.1 — storage usage reconcile. Empty payload; the worker reads all
// workspaces and recomputes usage_bytes from the live asset table.
export const ReconcileStorageUsageJobSchema = z.object({}).strict();
export type ReconcileStorageUsageJob = z.infer<typeof ReconcileStorageUsageJobSchema>;

/** Job-name constants so producers + workers can never disagree on string keys. */
export const JobNames = {
  ProcessAsset: "process-asset",
  Ocr: "ocr",
  Thumbnail: "thumbnail",
  // Phase 1.1 — explicit name for the multi-resolution derivative pipeline.
  // Distinct from the legacy `Thumbnail` placeholder so future variants
  // (e.g. animated WebP, video posterframe) can land on the same queue
  // without ambiguity. Producers should use this name going forward.
  GenerateThumbnails: "generate-thumbnails",
  Classify: "classify",
  ReapStuckAssets: "reap-stuck-assets",
  // Phase 3.2 — daily audit_log retention sweep.
  PruneAuditLog: "prune-audit-log",
  // Phase 2.4 — outbound webhook delivery (one job per delivery attempt).
  DeliverWebhook: "deliver-webhook",
  // Phase 4.2 — CLIP image embedding job.
  EmbedAsset: "embed-asset",
  // Phase 4.5 — second-pass CLIP-similarity dedup check. Enqueued when the
  // inline embed in createAssetRow() exceeds the inline budget, or as a
  // backfill sweep.
  ClipDedupCheck: "clip-dedup-check",
  // Phase 5.1 — face detection + ArcFace embedding for a single asset.
  // Enqueued after thumbnails complete; the worker writes
  // `fonto.face_instances` rows.
  FaceDetect: "face-detect",
  // Phase 7a — daily activity digest dispatch.
  DailyDigest: "daily-digest",
  // Phase 8b — HLS ladder transcode + sprite generation for one video.
  VideoHlsTranscode: "video-hls-transcode",
  // Phase 9.1 — nightly reconcile of workspace usage_bytes from asset rows.
  // Corrects any drift from incremental updates (dedup edge cases, bugs,
  // direct R2 deletes that bypassed the API).
  ReconcileStorageUsage: "reconcile-storage-usage",
} as const;

export type JobName = (typeof JobNames)[keyof typeof JobNames];
