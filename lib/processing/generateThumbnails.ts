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
import { assetDerivativeKey, assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
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
}

async function downloadOriginal(bucket: string, key: string): Promise<Buffer> {
  return storage().getBuffer(key);
}

async function uploadDerivative(
  bucket: string,
  key: string,
  body: Buffer
): Promise<void> {
  await storage().put(key, body, {
    contentType: "image/webp",
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
  }

  // Encode both variants in parallel — sharp pipelines are independent. CPU
  // contention is bounded by the worker's `THUMBNAIL_WORKER_CONCURRENCY`.
  const [thumb, preview] = await Promise.all([
    encodeVariant(decodedBuffer, THUMB_LONG_EDGE_PX, THUMB_QUALITY),
    encodeVariant(decodedBuffer, PREVIEW_LONG_EDGE_PX, PREVIEW_QUALITY),
  ]);

  const thumbnailKey = assetDerivativeKey(workspaceId, assetId, "thumb");
  const previewKey = assetDerivativeKey(workspaceId, assetId, "preview");

  await Promise.all([
    uploadDerivative(bucket, thumbnailKey, thumb),
    uploadDerivative(bucket, previewKey, preview),
  ]);

  log.info(
    { thumbBytes: thumb.length, previewBytes: preview.length },
    "derivatives uploaded"
  );

  await db
    .update(schema.assets)
    .set({
      thumbnailKey,
      previewKey,
      thumbnailGeneratedAt: new Date(),
    })
    .where(eq(schema.assets.id, assetId));

  return {
    skipped: false,
    thumbnailKey,
    previewKey,
    thumbBytes: thumb.length,
    previewBytes: preview.length,
  };
}
