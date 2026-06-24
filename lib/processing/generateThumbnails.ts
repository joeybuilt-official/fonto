// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.1 — multi-resolution derivative generation.
//
// Downloads an asset's original from R2, generates two WebP derivatives via
// sharp (256px thumb for the grid, 1080px preview for the lightbox), uploads
// them under `derivatives/{thumb,preview}.webp` with a 1-year immutable
// cache header, and stamps the keys + generation time onto the assets row.
//
// Idempotent: re-running for the same assetId overwrites the same R2 keys
// with the same content and re-stamps the timestamp. Safe to call from the
// worker, the reaper, or the backfill script.
//
// Non-image MIME types (`application/*`, ...) are skipped silently —
// video/* takes the video branch (probe + ffmpeg keyframe extraction
// → same WebP encode pipeline).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  assetDerivativeKey,
  assetResponsiveDerivativeKey,
  assetMotionKey,
  assetStorageKey,
} from "@/lib/r2";
import { storage } from "@/lib/storage";
import { findEmbeddedMotionVideo } from "@/lib/processing/extractMotionPhoto";
import { pairAppleMotion } from "@/lib/processing/motionPairing";
import { nextSeq } from "@/lib/db/seq";
import { decodeToBuffer } from "@/lib/processing/decode";
import { probeVideo } from "@/lib/processing/probeVideo";
import { extractVideoThumbnail } from "@/lib/processing/extractVideoThumbnail";
import {
  renderPdfFirstPage,
  pdfPageCount,
} from "@/lib/processing/renderPdfFirstPage";

const THUMB_LONG_EDGE_PX = 256;
const PREVIEW_LONG_EDGE_PX = 1080;
const THUMB_QUALITY = 80;
const PREVIEW_QUALITY = 82;
// T2.3 (fonto-perf-audit 2026-06-15) — responsive tier sizes + AVIF quality.
// AVIF at q50/effort4 lands ~25-35% smaller than equivalent WebP at q80, at
// the cost of ~3-5× encode CPU on a 4MP photo. Effort 4 is the sweet spot;
// effort 6+ doubles encode time for <5% size improvement.
const THUMB_512_LONG_EDGE_PX = 512;
const THUMB_1024_LONG_EDGE_PX = 1024;
const AVIF_QUALITY = 50;
// T2.4 — tiny "Low Quality Image Placeholder" baked into the same encode pass.
// 4x4 WebP @ q25 lands ~50–200 bytes; encoded inline as a data URL on the row
// so the grid can render it as `background-image` while the 256px thumb loads.
const LQIP_EDGE_PX = 4;
const LQIP_QUALITY = 25;
// One year, immutable. Derivative keys are content-addressed by (workspace,
// asset, variant); regenerating produces the same bytes for the same input,
// so clients can cache aggressively.
const DERIVATIVE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface GenerateThumbnailsInput {
  assetId: string;
  workspaceId: string;
}

export interface GenerateThumbnailsResult {
  skipped: boolean;
  reason?: "non-image" | "asset-missing" | "no-r2-bucket";
  thumbnailKey?: string;
  previewKey?: string;
  thumbBytes?: number;
  previewBytes?: number;
  // T2.4 — encoded data URL (`data:image/webp;base64,…`) length, for logging.
  lqipBytes?: number;
  // T2.3 — responsive tier byte counts for logging / cost analysis.
  thumb256AvifBytes?: number;
  thumb512WebpBytes?: number;
  thumb512AvifBytes?: number;
  thumb1024WebpBytes?: number;
  thumb1024AvifBytes?: number;
  previewAvifBytes?: number;
}

async function downloadOriginal(bucket: string, key: string): Promise<Buffer> {
  return storage().getBuffer(key);
}

async function uploadDerivative(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: "image/webp" | "image/avif" = "image/webp"
): Promise<void> {
  await storage().put(key, body, {
    contentType,
    contentLength: body.length,
    cacheControl: DERIVATIVE_CACHE_CONTROL,
  });
}

/**
 * Encode a single derivative variant. `.rotate()` (no args) auto-applies the
 * EXIF orientation tag and strips it from the output so consumers don't have
 * to know about orientation at all.
 */
async function encodeVariant(
  source: Buffer,
  longEdgePx: number,
  quality: number
): Promise<Buffer> {
  return sharp(source, { failOn: "none" })
    .rotate()
    .resize({
      width: longEdgePx,
      height: longEdgePx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality, effort: 4 })
    .toBuffer();
}

/**
 * T2.3 — AVIF sibling of `encodeVariant()`. Same resize policy
 * (`withoutEnlargement: true` so a 200×200 source doesn't get upscaled to
 * 1024×1024), libavif effort 4 = encode-time sweet spot.
 */
async function encodeAvifVariant(
  source: Buffer,
  longEdgePx: number,
  quality: number
): Promise<Buffer> {
  return sharp(source, { failOn: "none" })
    .rotate()
    .resize({
      width: longEdgePx,
      height: longEdgePx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .avif({ quality, effort: 4 })
    .toBuffer();
}

export async function generateThumbnails(
  input: GenerateThumbnailsInput
): Promise<GenerateThumbnailsResult> {
  const { assetId, workspaceId } = input;
  const log = logger.child({ component: "thumbnails", assetId, workspaceId });

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    log.error("R2_BUCKET unset — cannot generate thumbnails");
    return { skipped: true, reason: "no-r2-bucket" };
  }

  const [asset] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);

  if (!asset) {
    log.warn("asset row missing");
    return { skipped: true, reason: "asset-missing" };
  }

  // Phase 8a — video assets take a different decode path: ffprobe for
  // metadata, ffmpeg keyframe extraction for the thumbnail. The
  // extracted JPEG is then handed to the same sharp encode pipeline as
  // images so thumb/preview keys + cache headers stay uniform.
  const isVideo = asset.mimeType.startsWith("video/");
  const isPdf = asset.mimeType === "application/pdf";
  if (!asset.mimeType.startsWith("image/") && !isVideo && !isPdf) {
    log.info({ mimeType: asset.mimeType }, "non-image / non-video — skipping");
    return { skipped: true, reason: "non-image" };
  }

  const originalKey = assetStorageKey(workspaceId, assetId, asset.filename);
  const original = await downloadOriginal(bucket, originalKey);
  log.info({ bytes: original.length }, "downloaded original");

  let decodedBuffer: Buffer;
  // M12 / ADR 0014 — set when this still carries an embedded Android motion
  // clip we extracted + uploaded. Folded into the final row UPDATE below.
  let motionVideoKey: string | null = null;
  if (isVideo) {
    // ffmpeg's accurate-seek wants a file path; pipe-via-stdin defeats
    // keyframe seeking. Write to a tmp file, probe, extract, unlink.
    const tmp = path.join(os.tmpdir(), `fonto-vid-${assetId}.bin`);
    await fs.promises.writeFile(tmp, original);
    try {
      const probe = await probeVideo(tmp);
      log.info(probe, "probed video");
      const thumbAt = probe.durationSec
        ? Math.max(probe.durationSec * 0.1, 1)
        : 1;
      decodedBuffer = await extractVideoThumbnail(tmp, {
        atSec: thumbAt,
        maxWidth: PREVIEW_LONG_EDGE_PX,
      });
      // Stamp probe metadata onto the row alongside the thumbnail keys
      // (single UPDATE below covers both — set them on the asset first
      // here so a downstream failure still preserves the probe.)
      await db
        .update(schema.assets)
        .set({
          durationSeconds: probe.durationSec,
          videoCodec: probe.codec,
          videoWidth: probe.width,
          videoHeight: probe.height,
        })
        .where(eq(schema.assets.id, assetId));
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
    // M12 / ADR 0014 — Apple Live Photo: a short `.MOV` sibling of a still.
    // durationSeconds was just stamped above, so pairing can run now. Best-
    // effort; the workspace reconcile sweep is the safety net for stragglers
    // whose still hadn't imported yet.
    try {
      await pairAppleMotion(assetId);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "apple motion pairing failed"
      );
    }
  } else if (isPdf) {
    // Phase 6.7 — documents render their first page via poppler's pdftoppm
    // (PNG), then ride the same sharp encode pipeline as images. pdfinfo
    // supplies the page count. pdftoppm wants a file path, not stdin.
    const tmp = path.join(os.tmpdir(), `fonto-pdf-${assetId}.pdf`);
    await fs.promises.writeFile(tmp, original);
    try {
      const pages = await pdfPageCount(tmp);
      log.info({ pages }, "read pdf page count");
      decodedBuffer = await renderPdfFirstPage(tmp, { dpi: 150 });
      if (pages != null) {
        await db
          .update(schema.assets)
          .set({ pageCount: pages })
          .where(eq(schema.assets.id, assetId));
      }
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  } else {
    // Phase 1.3 — route HEIC + RAW through the decoder dispatcher so sharp
    // gets a buffer it can actually read. For web formats (JPEG/PNG/WebP/...)
    // this is a passthrough; for HEIC it uses sharp(libheif) or heif-convert;
    // for RAW it shells out to dcraw_emu. Failures here are real (corrupt
    // input) and should fail the job so the reaper can retry / mark failed.
    const decoded = await decodeToBuffer(original, asset.mimeType, asset.filename);
    log.info(
      { sourceFormat: decoded.sourceFormat, decodedBytes: decoded.buffer.length },
      "decoded"
    );
    decodedBuffer = decoded.buffer;

    // M12 / ADR 0014 — Android motion photo: an MP4 clip is appended after
    // the JPEG EOI. Byte-scan the in-memory original (already downloaded for
    // the decode above — no extra read), slice the clip, and upload it as a
    // `motion.mp4` derivative. Byte-copy only; the original JPEG is untouched.
    // Best-effort: extraction never blocks the thumbnail job.
    try {
      const motion = findEmbeddedMotionVideo(original);
      if (motion) {
        const clip = original.subarray(motion.offset, motion.offset + motion.length);
        const key = assetMotionKey(workspaceId, assetId);
        await storage().put(key, clip, {
          contentType: "video/mp4",
          contentLength: clip.length,
          cacheControl: DERIVATIVE_CACHE_CONTROL,
        });
        motionVideoKey = key;
        log.info({ motionBytes: clip.length, key }, "extracted motion clip");
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "motion-photo extraction failed"
      );
    }
  }

  // Encode all variants in parallel — sharp pipelines are independent. CPU
  // contention is bounded by the worker's `THUMBNAIL_WORKER_CONCURRENCY`.
  // T2.4 — the 4x4 LQIP rides along in the same Promise.all. It's a separate
  // sharp pipeline (cover-fit, low effort) so the regular 256/1080 outputs
  // are bit-identical to pre-T2.4 — LQIP is purely additive.
  // T2.3 — six new responsive variants (256@avif, 512@webp, 512@avif,
  // 1024@webp, 1024@avif, 1080@avif) join the same Promise.all for a total
  // of 9 sharp encode passes. CPU-bound; the 1024@avif pass dominates
  // (~500-1500ms on a 4MP photo). Worker concurrency caps the queue depth.
  const [
    thumb256,
    thumb256Avif,
    thumb512,
    thumb512Avif,
    thumb1024,
    thumb1024Avif,
    preview,
    previewAvif,
    lqipBuffer,
  ] = await Promise.all([
    encodeVariant(decodedBuffer, THUMB_LONG_EDGE_PX, THUMB_QUALITY),
    encodeAvifVariant(decodedBuffer, THUMB_LONG_EDGE_PX, AVIF_QUALITY),
    encodeVariant(decodedBuffer, THUMB_512_LONG_EDGE_PX, THUMB_QUALITY),
    encodeAvifVariant(decodedBuffer, THUMB_512_LONG_EDGE_PX, AVIF_QUALITY),
    encodeVariant(decodedBuffer, THUMB_1024_LONG_EDGE_PX, THUMB_QUALITY),
    encodeAvifVariant(decodedBuffer, THUMB_1024_LONG_EDGE_PX, AVIF_QUALITY),
    encodeVariant(decodedBuffer, PREVIEW_LONG_EDGE_PX, PREVIEW_QUALITY),
    encodeAvifVariant(decodedBuffer, PREVIEW_LONG_EDGE_PX, AVIF_QUALITY),
    sharp(decodedBuffer, { failOn: "none" })
      .rotate()
      .resize(LQIP_EDGE_PX, LQIP_EDGE_PX, { fit: "cover" })
      .webp({ quality: LQIP_QUALITY, effort: 3 })
      .toBuffer(),
  ]);
  const lqip = `data:image/webp;base64,${lqipBuffer.toString("base64")}`;

  const thumbnailKey = assetDerivativeKey(workspaceId, assetId, "thumb");
  const previewKey = assetDerivativeKey(workspaceId, assetId, "preview");
  const thumbnail256AvifKey = assetResponsiveDerivativeKey(
    workspaceId,
    assetId,
    "thumb_256_avif"
  );
  const thumbnail512WebpKey = assetResponsiveDerivativeKey(
    workspaceId,
    assetId,
    "thumb_512_webp"
  );
  const thumbnail512AvifKey = assetResponsiveDerivativeKey(
    workspaceId,
    assetId,
    "thumb_512_avif"
  );
  const thumbnail1024WebpKey = assetResponsiveDerivativeKey(
    workspaceId,
    assetId,
    "thumb_1024_webp"
  );
  const thumbnail1024AvifKey = assetResponsiveDerivativeKey(
    workspaceId,
    assetId,
    "thumb_1024_avif"
  );
  const previewAvifKey = assetResponsiveDerivativeKey(
    workspaceId,
    assetId,
    "preview_avif"
  );

  await Promise.all([
    uploadDerivative(bucket, thumbnailKey, thumb256),
    uploadDerivative(bucket, previewKey, preview),
    uploadDerivative(bucket, thumbnail256AvifKey, thumb256Avif, "image/avif"),
    uploadDerivative(bucket, thumbnail512WebpKey, thumb512),
    uploadDerivative(bucket, thumbnail512AvifKey, thumb512Avif, "image/avif"),
    uploadDerivative(bucket, thumbnail1024WebpKey, thumb1024),
    uploadDerivative(bucket, thumbnail1024AvifKey, thumb1024Avif, "image/avif"),
    uploadDerivative(bucket, previewAvifKey, previewAvif, "image/avif"),
  ]);

  log.info(
    {
      thumbBytes: thumb256.length,
      previewBytes: preview.length,
      lqipBytes: lqip.length,
      thumb256AvifBytes: thumb256Avif.length,
      thumb512WebpBytes: thumb512.length,
      thumb512AvifBytes: thumb512Avif.length,
      thumb1024WebpBytes: thumb1024.length,
      thumb1024AvifBytes: thumb1024Avif.length,
      previewAvifBytes: previewAvif.length,
    },
    "derivatives uploaded"
  );

  // M12 — bump seq when a motion clip was found so delta-sync propagates the
  // motionPhoto flag (+ the LIVE badge) to offline clients. Skipped otherwise
  // to keep the thumbnail job off the seq allocator on the common path.
  const motionFields = motionVideoKey
    ? {
        motionPhoto: true,
        motionVideoKey,
        seq: await nextSeq(workspaceId, "asset"),
      }
    : {};

  await db
    .update(schema.assets)
    .set({
      thumbnailKey,
      previewKey,
      thumbnail256AvifKey,
      thumbnail512WebpKey,
      thumbnail512AvifKey,
      thumbnail1024WebpKey,
      thumbnail1024AvifKey,
      previewAvifKey,
      thumbnailGeneratedAt: new Date(),
      lqip,
      ...motionFields,
    })
    .where(eq(schema.assets.id, assetId));

  return {
    skipped: false,
    thumbnailKey,
    previewKey,
    thumbBytes: thumb256.length,
    previewBytes: preview.length,
    lqipBytes: lqip.length,
    thumb256AvifBytes: thumb256Avif.length,
    thumb512WebpBytes: thumb512.length,
    thumb512AvifBytes: thumb512Avif.length,
    thumb1024WebpBytes: thumb1024.length,
    thumb1024AvifBytes: thumb1024Avif.length,
    previewAvifBytes: previewAvif.length,
  };
}
