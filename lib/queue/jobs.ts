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
  // Phase 4.5 — second-pass CLIP-similarity dedup check. Enqueued when the
  // inline embed in createAssetRow() exceeds the inline budget, or as a
  // backfill sweep.
  ClipDedupCheck: "clip-dedup-check",
} as const;

export type JobName = (typeof JobNames)[keyof typeof JobNames];
