// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { S3Client } from "@aws-sdk/client-s3";

let _s3: S3Client | null = null;
let _s3Streaming: S3Client | null = null;

// Socket-inactivity budget for every R2 request, in ms.
//
// Why this exists: the AWS SDK ships `DEFAULT_REQUEST_TIMEOUT = 0` — no
// timeout at all. On 2026-08-31 that deadlocked the thumbnail queue: two
// sockets to R2 (172.64.x.x:443) sat in CLOSE_WAIT holding 1,363,984 and
// 269,378 bytes of undelivered response body, the job promises never settled,
// and 12 `generate-thumbnails` slots were held for 40 minutes with 5,325 jobs
// waiting and the workers at 0.4% CPU. Same shape as the 12-hour multi-GB
// stall the week before. R2 half-closes a connection, the SDK waits forever.
//
// MUST STAY UNDER 6000. @smithy/node-http-handler installs the socket timeout
// immediately only when `0 < socketTimeout < 6000`; at 6000 or above it defers
// registration by 3s, and the handler's `resolve` (which fires as soon as
// response HEADERS arrive, long before a streamed body is drained) clears that
// pending registration. A value of 6000+ therefore leaves exactly the case
// that hung us — draining a response body — completely unguarded.
//
// This is inactivity, not total duration: every byte received resets it, so a
// multi-GB video download is unaffected as long as bytes keep arriving. A
// genuinely slow-but-progressing giant file is bounded by the size ceiling in
// generateThumbnails.ts instead.
//
// A timeout here rejects with a retryable TimeoutError, so the SDK's own retry
// policy re-issues the call on a fresh socket. The dead socket is destroyed
// rather than parked in the agent's pool.
const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

// Connection-establishment budget — TIME TO OPEN THE TCP SOCKET, a distinct
// smithy setting from socketTimeout above (post-connection inactivity). Left
// at the @smithy/node-http-handler default of 3000ms until C3 (2026-09-09)
// found it live-firing in production: 14 `hls_state='failed'` rows carrying
// `socket did not establish ... within 3000 ms`, clustered in the same
// 2026-07-06/07 windows as documented worker-contention incidents (10 rows
// share the 05:07-07:13Z window that held 12 worker slots for 40 minutes on
// giant multi-GB QuickTimes; 2 of those 10 rows ARE 10.98GB/13.2GB files).
// Many concurrent R2 connections competing for the outbound path during a
// transcode/backfill burst can legitimately push TCP handshake time past 3s
// — that is contention, not a dead peer, and doesn't deserve to fail.
//
// Unlike socketTimeout, this setting has NO 6000ms smithy registration cliff
// to respect (that cliff is specific to the socket-timeout install path in
// node-http-handler) — so there's no correctness ceiling forcing a small
// number here, only a judgement call on "how long is a legitimate handshake
// allowed to take under load before we call it dead." 10s: generous enough
// to ride out the exact contention profile that produced the 14-row
// incident, while still bounded — a genuinely unreachable R2 endpoint fails
// within 10s and lets the SDK's retry policy (or BullMQ's job retry) recover
// on a fresh attempt, rather than hanging indefinitely.
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export interface R2Timeouts {
  connectionTimeout: number;
  socketTimeout: number;
}

function timeoutFromEnv(name: string, fallback: number, ceilingExclusive?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  // Guard the 6000ms cliff documented above — an operator raising this to
  // "be safe" would silently disable body-drain protection.
  if (ceilingExclusive != null && parsed >= ceilingExclusive) return fallback;
  return parsed;
}

/**
 * Resolve the R2 transport timeouts from the environment. Exported so the
 * 6000ms cliff documented above is pinned by a test rather than by a comment
 * nobody re-reads — an operator raising R2_SOCKET_TIMEOUT_MS past it would
 * otherwise silently restore the deadlock this whole block exists to prevent.
 */
export function resolveR2Timeouts(): R2Timeouts {
  return {
    connectionTimeout: timeoutFromEnv(
      "R2_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONNECTION_TIMEOUT_MS
    ),
    socketTimeout: timeoutFromEnv(
      "R2_SOCKET_TIMEOUT_MS",
      DEFAULT_SOCKET_TIMEOUT_MS,
      6_000
    ),
  };
}

function baseClientConfig() {
  return {
    endpoint: process.env.R2_ENDPOINT,
    region: "auto" as const,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  };
}

/**
 * The client for every R2 call WE drain ourselves — processing, uploads,
 * reconcile, presign, stat, put, delete. Socket-timeout armed, because if we
 * are the consumer then a silent socket means a dead socket.
 */
export function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      ...baseClientConfig(),
      requestHandler: resolveR2Timeouts(),
    });
  }
  return _s3;
}

/**
 * The client for R2 reads whose body is handed STRAIGHT to a client response
 * (HLS segment playback, zip export). Deliberately NOT socket-timeout armed.
 *
 * Those streams are consumer-paced: a paused video player or a slow download
 * applies backpressure, the TCP window closes, and the socket legitimately
 * goes quiet for longer than any inactivity budget we would want on our own
 * reads. Arming the timeout here would destroy the transfer mid-flight and
 * turn a slow connection into a broken segment or a truncated zip.
 *
 * The hang this guards against elsewhere is bounded here by the request's own
 * lifecycle — the client disconnects and the response stream is torn down.
 * Use this ONLY when the bytes leave the process; anything we drain ourselves
 * uses getS3Client().
 */
export function getS3StreamingClient(): S3Client {
  if (!_s3Streaming) {
    _s3Streaming = new S3Client(baseClientConfig());
  }
  return _s3Streaming;
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
