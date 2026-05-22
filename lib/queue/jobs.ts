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

export const ClassifyJobSchema = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type ClassifyJob = z.infer<typeof ClassifyJobSchema>;

/** Job-name constants so producers + workers can never disagree on string keys. */
export const JobNames = {
  ProcessAsset: "process-asset",
  Ocr: "ocr",
  Thumbnail: "thumbnail",
  Classify: "classify",
} as const;

export type JobName = (typeof JobNames)[keyof typeof JobNames];
