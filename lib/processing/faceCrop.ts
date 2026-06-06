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
// chin-to-brow rectangle. Was 0.30 — group photos with adjacent faces
// produced cluster avatars containing 2-3 faces because the padding ate
// into neighbors. 0.15 + per-side neighbor-aware clipping (see
// `clipPaddingAgainstNeighbors`) now enforces one face per circle.
const FACE_CROP_PADDING = 0.15;
// When the source bbox in the chosen source image is smaller than this
// many pixels on its shorter side, the 256-target crop would have to
// upscale by 2× or more and the face goes soft. We switch to the original
// asset for that one decode so small in-frame faces stay sharp.
const HI_RES_SOURCE_MIN_BBOX_PX = 256;
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
  src: FaceCropSource,
  faces: FaceCropTarget[]
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const previewKey =
    src.previewKey ??
    assetDerivativeKey(src.workspaceId, src.assetId, "preview");
  const originalKey = assetStorageKey(
    src.workspaceId,
    src.assetId,
    src.filename
  );

  // Load preview first; it's the same frame the detector ran on so the
  // normalised bbox lines up exactly.
  const previewOriented = await loadAndOrient(bucket, previewKey).catch(
    () => null
  );

  // If the smallest face's bbox in preview-space would be <256 px on its
  // shorter side, falling back to the original gives us sharp pixels.
  // Preview and original share aspect (preview is just a downscale), so
  // the normalised bbox maps 1:1 in both.
  if (previewOriented && faces.length > 0) {
    const minPxInPreview = faces.reduce((min, f) => {
      const w = f.bbox.w * previewOriented.width;
      const h = f.bbox.h * previewOriented.height;
      return Math.min(min, Math.min(w, h));
    }, Infinity);
    if (minPxInPreview >= HI_RES_SOURCE_MIN_BBOX_PX) return previewOriented;
  }

  // Either preview is missing OR there's at least one small face — use original.
  try {
    return await loadAndOrient(bucket, originalKey);
  } catch {
    if (previewOriented) return previewOriented;
    throw new Error("could not load preview or original for face crops");
  }
}

async function loadAndOrient(
  bucket: string,
  key: string
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const raw = await downloadFromR2(bucket, key);
  const oriented = await sharp(raw, { failOn: "none" }).rotate().toBuffer();
  const meta = await sharp(oriented).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("source has zero dimensions after orientation");
  }
  return { buffer: oriented, width, height };
}

/**
 * Per-side clipping: shrink the padded region on any side that would
 * otherwise contain a NEIGHBOR face's center. Without this, a 15% pad
 * still bleeds into a close-by neighbor's chin/forehead and the cluster
 * avatar shows two heads. Operates entirely in normalised space.
 */
function clipPaddingAgainstNeighbors(
  target: FaceBbox,
  padded: { nx: number; ny: number; nw: number; nh: number },
  neighbors: FaceBbox[]
): { nx: number; ny: number; nw: number; nh: number } {
  if (neighbors.length === 0) return padded;

  const targetCx = target.x + target.w / 2;
  const targetCy = target.y + target.h / 2;
  const targetRight = target.x + target.w;
  const targetBottom = target.y + target.h;

  let { nx, ny, nw, nh } = padded;
  let right = nx + nw;
  let bottom = ny + nh;

  for (const n of neighbors) {
    const nCx = n.x + n.w / 2;
    const nCy = n.y + n.h / 2;
    const nRight = n.x + n.w;
    const nBottom = n.y + n.h;

    // Each clip is bounded so the resulting region always still contains
    // the WHOLE target bbox — clipping into the target itself produces
    // a degenerate or face-cut crop, which is worse than including a
    // sliver of a neighbor. The padded edge can be tightened down to
    // the target's own edge, no further.
    if (nCx > targetCx && right > n.x) {
      const limit = (targetRight + n.x) / 2;
      if (limit > targetRight && limit < right) right = limit;
      else if (limit <= targetRight) right = Math.min(right, targetRight);
    }
    if (nCx < targetCx && nx < nRight) {
      const limit = (target.x + nRight) / 2;
      if (limit < target.x && limit > nx) nx = limit;
      else if (limit >= target.x) nx = Math.max(nx, target.x);
    }
    if (nCy > targetCy && bottom > n.y) {
      const limit = (targetBottom + n.y) / 2;
      if (limit > targetBottom && limit < bottom) bottom = limit;
      else if (limit <= targetBottom) bottom = Math.min(bottom, targetBottom);
    }
    if (nCy < targetCy && ny < nBottom) {
      const limit = (target.y + nBottom) / 2;
      if (limit < target.y && limit > ny) ny = limit;
      else if (limit >= target.y) ny = Math.max(ny, target.y);
    }
  }

  nw = right - nx;
  nh = bottom - ny;
  return { nx, ny, nw, nh };
}

/** Map a normalised bbox (+padding, clipped against neighbors) to a clamped
 *  pixel extract region. */
function bboxToExtractRegion(
  bbox: FaceBbox,
  neighbors: FaceBbox[],
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } | null {
  const padW = bbox.w * FACE_CROP_PADDING;
  const padH = bbox.h * FACE_CROP_PADDING;
  let nx = bbox.x - padW;
  let ny = bbox.y - padH;
  let nw = bbox.w + padW * 2;
  let nh = bbox.h + padH * 2;
  // Clip the padded region per-side against any neighbor face's center, so
  // a cluster avatar never contains two heads.
  ({ nx, ny, nw, nh } = clipPaddingAgainstNeighbors(
    bbox,
    { nx, ny, nw, nh },
    neighbors
  ));
  // Clamp to [0,1] in normalised space.
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
  /** Other faces on the same asset (their bboxes). Used to clip padding
   *  so a crop never contains a neighbor's face. Empty array is fine. */
  neighbors?: FaceBbox[];
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
      args.neighbors ?? [],
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
    source = await loadOrientedSource(bucket, src, faces);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "could not load source for face crops — skipping asset"
    );
    return out;
  }

  for (const face of faces) {
    const neighbors = faces
      .filter((f) => f.faceId !== face.faceId)
      .map((f) => f.bbox);
    const key = await generateFaceCrop({
      bucket,
      workspaceId: src.workspaceId,
      assetId: src.assetId,
      faceId: face.faceId,
      bbox: face.bbox,
      neighbors,
      sourceBuffer: source.buffer,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    if (key) out.set(face.faceId, key);
  }
  return out;
}
