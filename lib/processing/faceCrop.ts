// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (faces/UX) — dedicated square face-crop derivative.
//
// Faces are detected with a NORMALISED bbox (0..1) against the asset's preview
// derivative. Every People surface (web grid + detail, Flutter circles) used to
// CSS/transform-zoom a whole-frame derivative against that bbox → pixelation
// for small in-frame faces + visibly off-center crops. Instead we crop the
// bbox region ONCE here (sharp `.extract` + ~30% padding, EXIF-orientation
// applied), resize to a 256px square, encode webp, and store it at
// `derivatives/face/{faceId}.webp`. The key lands on
// `face_instances.face_crop_key`. See ADR 0001 (D1).
//
// Source selection: prefer the asset's `preview` derivative (already decoded,
// web-safe, 1080px — the SAME image the detector saw, so the normalised bbox
// lines up exactly). Fall back to the original bytes if the preview key is NULL
// / missing. The bbox is normalised, so it maps onto whichever source we get.

import sharp from "sharp";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "@/lib/logger";
import {
  assetDerivativeKey,
  assetStorageKey,
  faceCropKey,
  getS3Client,
} from "@/lib/r2";

const FACE_CROP_SIZE_PX = 256;
const FACE_CROP_QUALITY = 82;
// Padding added around the detected bbox (fraction of the box's own
// width/height) so the crop frames the head + a little context, not a tight
// chin-to-brow rectangle. ~30% per ADR 0001.
const FACE_CROP_PADDING = 0.3;
const DERIVATIVE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface FaceBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceCropTarget {
  faceId: string;
  bbox: FaceBbox;
}

export interface FaceCropSource {
  workspaceId: string;
  assetId: string;
  filename: string;
  /** The asset's stored preview derivative key, if generated. */
  previewKey: string | null;
}

async function downloadFromR2(bucket: string, key: string): Promise<Buffer> {
  const out = await getS3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const chunks: Buffer[] = [];
  const body = out.Body as AsyncIterable<Uint8Array> | undefined;
  if (!body) throw new Error(`R2 object empty body: ${key}`);
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch the highest-res available source for an asset: the preview derivative
 * if present, else the original. Returns an EXIF-oriented RGBA-agnostic buffer
 * + its post-orientation pixel dimensions so callers can map a normalised
 * bbox to pixels.
 *
 * `.rotate()` (no args) bakes in the EXIF orientation and strips the tag, so
 * the returned dimensions are the VISUAL dimensions a viewer sees — which is
 * the frame the normalised bbox was computed against.
 */
async function loadOrientedSource(
  bucket: string,
  src: FaceCropSource
): Promise<{ buffer: Buffer; width: number; height: number }> {
  let raw: Buffer;
  const previewKey =
    src.previewKey ??
    assetDerivativeKey(src.workspaceId, src.assetId, "preview");
  try {
    raw = await downloadFromR2(bucket, previewKey);
  } catch {
    raw = await downloadFromR2(
      bucket,
      assetStorageKey(src.workspaceId, src.assetId, src.filename)
    );
  }
  // Bake EXIF orientation in once, then read the visual dimensions.
  const oriented = await sharp(raw, { failOn: "none" }).rotate().toBuffer();
  const meta = await sharp(oriented).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("source has zero dimensions after orientation");
  }
  return { buffer: oriented, width, height };
}

/** Map a normalised bbox (+padding) to a clamped pixel extract region. */
function bboxToExtractRegion(
  bbox: FaceBbox,
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } | null {
  const padW = bbox.w * FACE_CROP_PADDING;
  const padH = bbox.h * FACE_CROP_PADDING;
  let nx = bbox.x - padW;
  let ny = bbox.y - padH;
  let nw = bbox.w + padW * 2;
  let nh = bbox.h + padH * 2;
  // Clamp to [0,1] in normalised space first.
  if (nx < 0) {
    nw += nx;
    nx = 0;
  }
  if (ny < 0) {
    nh += ny;
    ny = 0;
  }
  if (nx + nw > 1) nw = 1 - nx;
  if (ny + nh > 1) nh = 1 - ny;
  if (nw <= 0 || nh <= 0) return null;

  const left = Math.round(nx * width);
  const top = Math.round(ny * height);
  // sharp.extract is exclusive on the far edge; clamp so left+w <= width.
  const region = {
    left: Math.min(left, width - 1),
    top: Math.min(top, height - 1),
    width: Math.max(1, Math.min(Math.round(nw * width), width - left)),
    height: Math.max(1, Math.min(Math.round(nh * height), height - top)),
  };
  return region;
}

/**
 * Generate + upload a single face crop. Returns the R2 key on success, or
 * null if the crop could not be produced (caller logs + skips so one bad face
 * never fails the whole asset / batch).
 *
 * `sourceBuffer` is the already-EXIF-oriented source bytes from
 * `loadOrientedSource`; passing it in lets a caller reuse one decode across
 * every face on the same asset.
 */
export async function generateFaceCrop(args: {
  bucket: string;
  workspaceId: string;
  assetId: string;
  faceId: string;
  bbox: FaceBbox;
  sourceBuffer: Buffer;
  sourceWidth: number;
  sourceHeight: number;
}): Promise<string | null> {
  const log = logger.child({
    component: "face-crop",
    assetId: args.assetId,
    faceId: args.faceId,
  });
  try {
    const region = bboxToExtractRegion(
      args.bbox,
      args.sourceWidth,
      args.sourceHeight
    );
    if (!region) {
      log.warn({ bbox: args.bbox }, "degenerate bbox — skipping crop");
      return null;
    }
    // Source is already EXIF-oriented, so no .rotate() here.
    const crop = await sharp(args.sourceBuffer, { failOn: "none" })
      .extract(region)
      .resize({
        width: FACE_CROP_SIZE_PX,
        height: FACE_CROP_SIZE_PX,
        fit: "cover",
        position: "centre",
      })
      .webp({ quality: FACE_CROP_QUALITY, effort: 4 })
      .toBuffer();

    const key = faceCropKey(args.workspaceId, args.assetId, args.faceId);
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: args.bucket,
        Key: key,
        Body: crop,
        ContentType: "image/webp",
        ContentLength: crop.length,
        CacheControl: DERIVATIVE_CACHE_CONTROL,
      })
    );
    return key;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "face crop failed — skipping"
    );
    return null;
  }
}

/**
 * Crop every face on a single asset from one shared decode of the source.
 * Returns a map of faceId -> crop key for the faces that succeeded; failures
 * are logged + omitted. Used by both detect-time (lib/processing/detectFaces)
 * and the backfill job (worker maintenance queue).
 */
export async function generateFaceCropsForAsset(
  bucket: string,
  src: FaceCropSource,
  faces: FaceCropTarget[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (faces.length === 0) return out;

  const log = logger.child({ component: "face-crop", assetId: src.assetId });
  let source: { buffer: Buffer; width: number; height: number };
  try {
    source = await loadOrientedSource(bucket, src);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "could not load source for face crops — skipping asset"
    );
    return out;
  }

  for (const face of faces) {
    const key = await generateFaceCrop({
      bucket,
      workspaceId: src.workspaceId,
      assetId: src.assetId,
      faceId: face.faceId,
      bbox: face.bbox,
      sourceBuffer: source.buffer,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    if (key) out.set(face.faceId, key);
  }
  return out;
}
