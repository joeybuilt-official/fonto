// SPDX-License-Identifier: MIT
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

// Phase 4.2 — CLIP image embedding job. The worker downloads the asset's
// preview derivative (or original if preview missing), POSTs to the Plexo
// vision service, and writes the returned 512-dim float vector to
// `assets.clip_vec` (lands with the 4.3 pgvector migration). Payload stays
// tiny — the worker rehydrates everything else from Postgres.
export const EmbedAssetJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  // E4-M6 — bounded delayed re-enqueue counter for preview-required mimes
  // whose sharp-decoded preview hasn't landed yet. The clip worker re-adds
  // the job with `delay` when `embedAsset` returns `preview-not-ready`,
  // giving the thumbnail worker time to produce the preview before the row
  // is left for the `backfill:clip` sweep. Absent on the original enqueue.
  previewRetries: z.number().int().min(0).default(0).optional(),
});
export type EmbedAssetJob = z.infer<typeof EmbedAssetJobSchema>;

// Maintenance: periodic sweep that re-enqueues or terminally fails any asset
// row stuck in processing_state='processing' past the threshold. Payload is
// empty — the reaper reads the world from Postgres on each tick.
export const ReapStuckAssetsJobSchema = z.object({}).strict();

// M5a (O4) — nightly auto-cluster sweep. Empty payload; the tick enumerates
// every workspace with embedded, non-hidden faces and enqueues one
// AutoClusterFaces job per workspace (the exact work the removed NAS-cron
// route did). Registered as a BullMQ repeatable job so the nightly run no
// longer depends on an external scheduler the operator must provision.
export const AutoClusterScanJobSchema = z.object({}).strict();
export type AutoClusterScanJob = z.infer<typeof AutoClusterScanJobSchema>;
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
  // Count of times this check has re-enqueued itself while waiting for the
  // upstream CLIP-embed to populate `clip_vec`. Bounds the self-re-enqueue
  // so an asset whose embed never lands (e.g. missing R2 original) cannot
  // loop forever. Absent on the first enqueue (treated as 0).
  dedupRetries: z.number().int().min(0).optional(),
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

// Task 20 (Phase 3) — auto-stacking sweep. Empty payload; the worker scans
// every workspace, derives stack suggestions, and materialises the
// conservative ones. Reversible (sets stack_id only) + idempotent.
export const AutoStackJobSchema = z.object({}).strict();
export type AutoStackJob = z.infer<typeof AutoStackJobSchema>;

// Phase 1 (faces/UX) — backfill face-crop derivatives for existing faces.
// Optional `batchSize` overrides the default small batch; the handler scans
// `face_crop_key IS NULL` so it's idempotent + resumable per tick.
export const BackfillFaceCropsJobSchema = z
  .object({ batchSize: z.number().int().positive().max(500).optional() })
  .strict();
export type BackfillFaceCropsJob = z.infer<typeof BackfillFaceCropsJobSchema>;

// Phase 0 (media import) — long-running, app-managed import job. The payload
// is just a pointer to the `import_jobs` row + the (workspace, user, provider)
// it belongs to; the worker rehydrates counts/cursor from Postgres and updates
// them in batches as it streams the archive. Resume is app-managed (the row's
// `cursor`), so the BullMQ queue runs attempts:1 — a BullMQ retry would restart
// the whole archive instead of resuming from the checkpoint.
export const ImportJobSchema = z.object({
  importJobId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string(),
  provider: z.enum(["google-takeout", "amazon-photos"]),
  // Phase 2 — the user-selected Google Drive Takeout archive to stream down.
  // Present for provider='google-takeout'; the worker streams this fileId via
  // Drive v3 (alt=media) to a temp file, then walks it member-by-member.
  driveFileId: z.string().optional(),
  // Phase 3 (Amazon) — a local temp ZIP path the upload endpoint already
  // streamed to disk. When set, the worker skips the Drive download entirely
  // and walks this file directly (EXIF-only, no Takeout sidecars). Lets the
  // same worker serve both importers without a second code path.
  uploadTmpPath: z.string().optional(),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

// Phase B3 (storage placement) — mirror an asset's ORIGINAL from R2 to the local
// backend (LOCAL_STORAGE_ROOT) for `mirror`-policy workspaces. Tiny payload: the
// handler reads the asset + effective policy from Postgres and streams the copy.
// Idempotent (skips when local_original_stored_at is already set). C2: originals
// only (derivatives stay on R2). C4: mirror only (no local_only this initiative).
export const StorageSyncJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type StorageSyncJob = z.infer<typeof StorageSyncJobSchema>;

// Intelligence Core — Phase 3 (extract-evidence). Tiny payload: the worker reads
// the asset (+ faces/persons/exif/ocr) from Postgres and optionally presigns the
// preview for the Plexo scene-label call. Writes `fonto.image_date_evidence`.
export const ExtractEvidenceJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type ExtractEvidenceJob = z.infer<typeof ExtractEvidenceJobSchema>;

// Intelligence Core — Phase 3 maintenance sweeps. Both empty-payload + read the
// world from Postgres on each tick.
//   - BackfillEvidence: enqueue extract-evidence for a bounded batch of assets
//     with no evidence rows yet (resumable via NOT EXISTS).
//   - BackfillVariantCandidates: recompute candidate variant groups per
//     workspace (idempotent).
export const BackfillEvidenceJobSchema = z
  .object({ batchSize: z.number().int().positive().max(1000).optional() })
  .strict();
export type BackfillEvidenceJob = z.infer<typeof BackfillEvidenceJobSchema>;

export const BackfillVariantCandidatesJobSchema = z.object({}).strict();
export type BackfillVariantCandidatesJob = z.infer<typeof BackfillVariantCandidatesJobSchema>;

// Intelligence Core — Phase 4 (infer-date). Tiny payload: the worker reads the
// asset's evidence rows + stored captured_at and writes one
// `fonto.image_date_inference` proposal (never touches captured_at).
export const InferDateJobSchema = z.object({
  assetId: z.string().uuid(),
});
export type InferDateJob = z.infer<typeof InferDateJobSchema>;

// Intelligence Core — Phase 4 maintenance sweep: enqueue infer-date for a
// bounded batch of assets that have evidence but no inference yet.
export const BackfillInferenceJobSchema = z
  .object({ batchSize: z.number().int().positive().max(2000).optional() })
  .strict();
export type BackfillInferenceJob = z.infer<typeof BackfillInferenceJobSchema>;

// Intelligence Core — Phase 8: one-off library-wide date reconcile. Carries the
// target workspace + batch/cap knobs. Operator-enqueued (gated); never a
// recurring schedule.
// M15.1 (ADR 0012) — when `bucket` is present the job applies a reversible
// action to one reason-bucket of the REVIEW band (apply-to-bucket); without it
// the job commits the auto-commit band (the original Phase-8 behaviour).
export const BackfillReconcileJobSchema = z
  .object({
    workspaceId: z.string().uuid(),
    batchSize: z.number().int().positive().max(1000).optional(),
    maxRows: z.number().int().nonnegative().optional(),
    // M15.4 / ADR 0059 — axis-agnostic opaque bucketKey is the new apply key.
    // Accept BOTH the new `{bucketKey}` payload AND the legacy
    // `{evidenceSource, conflict}` pair for one release, so in-flight queued
    // jobs (enqueued by the pre-deploy route) still resolve. The worker
    // normalises legacy → a `src:` bucketKey.
    bucket: z
      .object({
        bucketKey: z.string().optional(),
        evidenceSource: z.string().nullable().optional(),
        conflict: z.boolean().optional(),
        action: z.enum(["confirm", "reject", "quarantine"]),
        // M15.2 — when true, reverse the most recent bulk action on this bucket
        // (the snackbar Undo) instead of applying `action`.
        undo: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();
export type BackfillReconcileJob = z.infer<typeof BackfillReconcileJobSchema>;

// M15 closeout — nightly HNSW face auto-cluster. Per-workspace, no embedding
// vectors loaded into Node memory. Triggered by /api/v1/cron/auto-cluster.
export const AutoClusterFacesJobSchema = z.object({
  workspaceId: z.string().uuid(),
}).strict();
export type AutoClusterFacesJob = z.infer<typeof AutoClusterFacesJobSchema>;

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
  // Task 20 (Phase 3) — auto-stacking sweep (bursts / screenshot-runs /
  // near-dups). Reversible; sets stack_id only.
  AutoStack: "auto-stack",
  // Phase 1 (faces/UX) — throttled backfill of face-crop derivatives for
  // existing faces. Default-off recurring schedule (BACKFILL_FACE_CROPS=1) +
  // deliberate one-off enqueue.
  BackfillFaceCrops: "backfill-face-crops",
  // Phase 0 (media import) — Google Takeout / Amazon Photos archive import.
  // One job per import_jobs row; long-running + app-managed resume.
  Import: "media-import",
  // Phase B3 (storage placement) — mirror an asset's original R2→local.
  StorageSync: "storage-sync",
  // Phase B5 (storage placement) — throttled backfill: enqueue mirror-sync for
  // existing un-mirrored originals in mirror/local_only workspaces.
  BackfillStorageMirror: "backfill-storage-mirror",
  // Phase B5 (storage placement) — nightly reconcile: repair R2↔local divergence
  // for stamped mirror assets (restore local, re-push to R2, or flag loss).
  ReconcileStorageMirror: "reconcile-storage-mirror",
  // Intelligence Core (Phase 3) — per-asset date-evidence extraction.
  ExtractEvidence: "extract-evidence",
  // Intelligence Core (Phase 3) — bounded backfill: enqueue extract-evidence for
  // assets with no evidence rows yet.
  BackfillEvidence: "backfill-evidence",
  // Intelligence Core (Phase 3) — recompute variant candidates per workspace.
  BackfillVariantCandidates: "backfill-variant-candidates",
  // Intelligence Core (Phase 4) — per-asset date fusion (evidence -> inference).
  InferDate: "infer-date",
  // Intelligence Core (Phase 4) — bounded backfill: enqueue infer-date for assets
  // with evidence but no inference yet.
  BackfillInference: "backfill-inference",
  // Intelligence Core (Phase 8) — library-wide date reconcile: commit the
  // auto-commit date band (status='inferred' -> 'confirmed' + captured_at).
  // One-off, operator-enqueued; NOT a recurring schedule. Idempotent/resumable.
  BackfillReconcile: "backfill-reconcile",
  // M15 closeout — nightly HNSW face auto-cluster for one workspace. No
  // embedding vectors loaded into Node; DB-side pgvector HNSW does the work.
  AutoClusterFaces: "auto-cluster-faces",
  // M5a (O4) — nightly sweep that fans one AutoClusterFaces job out to every
  // workspace with face data. Owns the workspace enumeration so the nightly
  // run is fully worker-side (no external cron required).
  AutoClusterScan: "auto-cluster-scan",
} as const;

export type JobName = (typeof JobNames)[keyof typeof JobNames];
