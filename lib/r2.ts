// SPDX-License-Identifier: MIT
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
 * T2.3 (fonto-perf-audit 2026-06-15) — responsive derivative tiers.
 *
 * Per-asset srcset variants at 256/512/1024 (and 1080 for the lightbox
 * preview), each in WebP + AVIF. Layout sits next to the legacy
 * thumb.webp / preview.webp so the old keys keep working as fallbacks for
 * assets that haven't been re-processed yet.
 *
 *   thumb_256.avif    thumb_512.webp   thumb_512.avif
 *   thumb_1024.webp   thumb_1024.avif  preview.avif
 *
 * Stored on `assets.thumbnail_{256_avif,512_webp,512_avif,1024_webp,
 * 1024_avif}_key` and `assets.preview_avif_key`. Content-addressed by
 * (workspace, asset, variant) — same R2 cache policy as the legacy keys.
 */
export type ResponsiveDerivativeVariant =
  | "thumb_256_avif"
  | "thumb_512_webp"
  | "thumb_512_avif"
  | "thumb_1024_webp"
  | "thumb_1024_avif"
  | "preview_avif";

export function assetResponsiveDerivativeKey(
  workspaceId: string,
  assetId: string,
  variant: ResponsiveDerivativeVariant
): string {
  const ext = variant.endsWith("_avif") ? "avif" : "webp";
  const stem = variant.replace(/_(webp|avif)$/, "");
  return `fonto/${workspaceId}/${assetId}/derivatives/${stem}.${ext}`;
}

/**
 * Phase 1 (faces/UX) — dedicated face-crop derivative key.
 *
 * One square webp crop per detected face (sharp `.extract` of the bbox +
 * ~30% padding, EXIF-correct, ~256px), keyed by the face id so it's stable
 * across re-clustering / person re-assignment:
 *
 *   fonto/{ws}/{asset}/derivatives/face/{faceId}.webp
 *
 * Stored on `face_instances.face_crop_key`. Lives under the owning asset's
 * prefix so a workspace/asset delete sweeps the crops too.
 */
export function faceCropKey(
  workspaceId: string,
  assetId: string,
  faceId: string
): string {
  return `fonto/${workspaceId}/${assetId}/derivatives/face/${faceId}.webp`;
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

/**
 * M12 / ADR 0014 — extracted Android motion-photo clip.
 *
 *   fonto/{ws}/{asset}/motion.mp4
 *
 * Byte-copy of the MP4 embedded after the JPEG EOI; never re-encoded. Lives
 * under the owning asset's prefix so a workspace/asset delete sweeps it too.
 * Stored on `assets.motion_video_key`.
 */
export function assetMotionKey(workspaceId: string, assetId: string): string {
  return `fonto/${workspaceId}/${assetId}/motion.mp4`;
}
