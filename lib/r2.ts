// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { S3Client } from "@aws-sdk/client-s3";

let _s3: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: process.env.R2_ENDPOINT,
      region: "auto",
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return _s3;
}

export function assetStorageKey(workspaceId: string, assetId: string, filename: string): string {
  return `fonto/${workspaceId}/${assetId}/${filename}`;
}

// Legacy key format — used only for migration fallback during R2 key migration
export function assetStorageKeyLegacy(workspaceId: string, assetId: string, filename: string): string {
  return `${workspaceId}/${assetId}/${filename}`;
}

/**
 * Phase 1.1 — multi-resolution derivative key.
 *
 * Derivatives (256px thumb, 1080px preview) live alongside the original
 * under a `derivatives/` subkey. Always WebP, always lowercase variant name.
 *
 * Examples:
 *   thumb   → fonto/{ws}/{asset}/derivatives/thumb.webp
 *   preview → fonto/{ws}/{asset}/derivatives/preview.webp
 *
 * Keep this stable: it's stored in `assets.thumbnail_key` / `preview_key`
 * after generation. Changing the layout requires a backfill.
 */
export type DerivativeVariant = "thumb" | "preview";

export function assetDerivativeKey(
  workspaceId: string,
  assetId: string,
  variant: DerivativeVariant
): string {
  return `fonto/${workspaceId}/${assetId}/derivatives/${variant}.webp`;
}
