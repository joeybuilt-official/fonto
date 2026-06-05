// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — face detection + ArcFace embedding for a single asset.
//
// Loads the asset's 1080px preview derivative from R2, POSTs to the Plexo
// vision sidecar's `POST {PLEXO_VISION_URL}/v1/faces/detect`, and inserts
// one `fonto.face_instances` row per detection.
//
// The sidecar is expected to return:
//   {
//     faces: [
//       { bbox: { x, y, w, h }, confidence: number, embedding: number[512] },
//       ...
//     ]
//   }
//
// Coordinates are normalised (0..1) so the UI can scale them against any
// derivative variant. Embeddings are L2-normalised so cosine distance is
// 1 - dot(a, b).
//
// Graceful degradation:
//   - PLEXO_VISION_URL unset                  -> warn + no-op (no throw).
//   - sidecar HTTP/network error              -> warn + no-op (no throw).
//   - non-image MIME type                     -> warn + no-op.
//   - asset row missing / R2 object missing   -> warn + no-op.
//
// Re-running for the same asset is NOT idempotent — every call inserts new
// rows. Callers (the worker handler) are expected to only enqueue once per
// asset; manual re-runs from a CLI should DELETE existing rows for the
// asset first if a re-detection is desired.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  assetDerivativeKey,
  assetStorageKey,
  getS3Client,
} from "@/lib/r2";

const DEFAULT_TIMEOUT_MS = 30_000;

interface DetectFaceResponseBody {
  faces?: Array<{
    bbox?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
    confidence?: unknown;
    embedding?: unknown;
  }>;
}

interface ParsedFace {
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  embedding: number[];
}

function serviceKey(): string {
  return process.env.PLEXO_SERVICE_KEY ?? "";
}

function visionBase(): string | null {
  const raw = process.env.PLEXO_VISION_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
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

function parseFaces(raw: DetectFaceResponseBody): ParsedFace[] {
  const out: ParsedFace[] = [];
  for (const f of raw.faces ?? []) {
    const bx = f.bbox?.x;
    const by = f.bbox?.y;
    const bw = f.bbox?.w;
    const bh = f.bbox?.h;
    if (
      typeof bx !== "number" ||
      typeof by !== "number" ||
      typeof bw !== "number" ||
      typeof bh !== "number" ||
      !Number.isFinite(bx) ||
      !Number.isFinite(by) ||
      !Number.isFinite(bw) ||
      !Number.isFinite(bh)
    ) {
      continue;
    }
    const conf =
      typeof f.confidence === "number" && Number.isFinite(f.confidence)
        ? f.confidence
        : 0;
    const emb = f.embedding;
    if (!Array.isArray(emb) || emb.length === 0) continue;
    const numeric: number[] = new Array(emb.length);
    let ok = true;
    for (let i = 0; i < emb.length; i++) {
      const v = emb[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      numeric[i] = v;
    }
    if (!ok) continue;
    out.push({
      bbox: { x: bx, y: by, w: bw, h: bh },
      confidence: conf,
      embedding: numeric,
    });
  }
  return out;
}

/**
 * Run face detection + embedding for one asset.
 *
 * Always returns (never throws on degraded conditions). Logs at WARN level
 * for any skip / failure path so /admin can spot why a particular asset has
 * no face_instances rows.
 */
export async function detectFacesForAsset(assetId: string): Promise<void> {
  const log = logger.child({ component: "face-detect", assetId });

  const base = visionBase();
  if (!base) {
    log.warn("PLEXO_VISION_URL unset — skipping face detection");
    return;
  }

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    log.warn("R2_BUCKET unset — cannot fetch asset bytes");
    return;
  }

  const [asset] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      classification: schema.assets.classification,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);

  if (!asset) {
    log.warn("asset row missing");
    return;
  }
  if (!asset.mimeType.startsWith("image/")) {
    log.info({ mimeType: asset.mimeType }, "non-image asset — skipping");
    return;
  }
  // Only real photographs get face detection. Screenshots / documents /
  // receipts / memes etc. (classification != "photo") flooded the People view
  // with junk clusters. The enqueue is already gated in processAsset; this is
  // defense-in-depth for any direct/legacy caller. A null classification means
  // the asset hasn't been classified yet — let it through (the enqueue path
  // guarantees it was a photo).
  if (asset.classification != null && asset.classification !== "photo") {
    log.info({ classification: asset.classification }, "non-photo asset — skipping face detection");
    return;
  }

  // Prefer the 1080px preview — already decoded, web-safe. Fall back to the
  // original if the thumbnail pipeline hasn't generated it yet.
  const key =
    asset.previewKey ??
    assetDerivativeKey(asset.workspaceId, asset.id, "preview");

  let buffer: Buffer;
  try {
    buffer = await downloadFromR2(bucket, key);
  } catch (err) {
    // Fall back to the original if the preview hasn't landed in R2 yet.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), key },
      "preview download failed — trying original"
    );
    try {
      buffer = await downloadFromR2(
        bucket,
        assetStorageKey(asset.workspaceId, asset.id, asset.filename)
      );
    } catch (err2) {
      log.warn(
        { err: err2 instanceof Error ? err2.message : String(err2) },
        "original download failed — skipping"
      );
      return;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let body: DetectFaceResponseBody;
  try {
    const res = await fetch(`${base}/v1/faces/detect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(serviceKey() ? { authorization: `Bearer ${serviceKey()}` } : {}),
      },
      body: JSON.stringify({ image: buffer.toString("base64") }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        "plexo-vision /v1/faces/detect returned non-2xx — skipping"
      );
      return;
    }
    body = (await res.json()) as DetectFaceResponseBody;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "plexo-vision /v1/faces/detect call failed — skipping"
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  const faces = parseFaces(body);
  if (faces.length === 0) {
    log.info("no faces detected");
    return;
  }

  // Bulk insert. Each row carries the workspace_id so the People page can
  // scope queries from a single index.
  await db.insert(schema.faceInstances).values(
    faces.map((f) => ({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      bbox: f.bbox as unknown as Record<string, number>,
      confidence: f.confidence,
      embedding: f.embedding,
    }))
  );
  log.info({ count: faces.length }, "face instances inserted");
}
