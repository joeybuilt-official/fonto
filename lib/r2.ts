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

/**
 * Phase 8b — HLS storage layout.
 *
 *   fonto/{ws}/{asset}/hls/master.m3u8
 *   fonto/{ws}/{asset}/hls/{rendition}.m3u8
 *   fonto/{ws}/{asset}/hls/{rendition}_NNN.ts          (segments)
 *   fonto/{ws}/{asset}/hls/sprite.jpg                  (hover-scrub)
 *
 * Keep stable — stored on `assets.hls_master_key` + `sprite_key`.
 */
export function hlsMasterKey(workspaceId: string, assetId: string): string {
  return `fonto/${workspaceId}/${assetId}/hls/master.m3u8`;
}

export function hlsRenditionKey(
  workspaceId: string,
  assetId: string,
  rendition: string
): string {
  return `fonto/${workspaceId}/${assetId}/hls/${rendition}.m3u8`;
}

export function hlsSegmentKeyPrefix(workspaceId: string, assetId: string): string {
  return `fonto/${workspaceId}/${assetId}/hls/`;
}

export function hlsSpriteKey(workspaceId: string, assetId: string): string {
  return `fonto/${workspaceId}/${assetId}/hls/sprite.jpg`;
}
