// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared asset row creation: dedup check + EXIF + perceptual hash + insert +
// queue enqueue + plexo publish. Both the legacy multipart POST and the new
// /complete (presigned PUT) route call into this so we never drift on the
// per-upload bookkeeping.
//
// What this helper does NOT do:
// - It does not handle R2 storage. The legacy route uploads a buffer to R2
//   after a successful insert; the presigned-PUT path has already pushed the
//   object to R2 before getting here. Both call sites pass the in-memory
//   buffer for EXIF + pHash extraction.
// - It does not own the response shape. Each route serializes the returned
//   asset its own way (the legacy route attaches `possibleDuplicate`, etc.).

import { createHash } from "crypto";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { plexoPublishEvent } from "@/lib/plexo";
import {
  computePHash,
  extractPalette,
  hammingDistance,
  type PaletteColor,
} from "@/lib/perceptual";
import {
  findNearestAssetByPhashGraph,
  fontoGraphConfigured,
  mirrorAssetToGraph,
} from "@/lib/fonto-graph";
import { extractExif } from "@/lib/exif";
import { assetProcessingQueue, JobNames } from "@/lib/queue";
import { nextSeq } from "@/lib/db/seq";
// Phase 1.1 `thumbnailQueue` + `JobNames.GenerateThumbnails` resolved
// dynamically below so this module stays buildable if those exports
// disappear in a future refactor (or in a parallel-worktree merge with
// 1.1 not yet landed).
import { assetIngestTotal, classifyMime } from "@/lib/metrics";

// Hamming distance threshold for "near-duplicate" pHash matches.
// 0–4 = visually identical resizes/recompresses
// 5–10 = same scene, different crop or color shift
// 11+  = different image
export const PHASH_DUPLICATE_THRESHOLD = 5;

export type Asset = typeof schema.assets.$inferSelect;

export interface PossibleDuplicate {
  assetId: string;
  filename: string;
  capturedAt: string | null;
  createdAt: string;
  distance: number;
  thumbUrl: string;
}

export interface CreateAssetInput {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256. If undefined, computed from the buffer here. */
  sha256?: string;
  /** Full asset buffer for EXIF / pHash / palette extraction. */
  buffer: Buffer;
  source: string;
}

export interface CreateAssetResult {
  /** The newly-inserted asset row. */
  asset: Asset;
  /** True iff a SHA-256 match was found and we returned the existing row. */
  deduplicated: boolean;
  /** Near-duplicate by pHash (NOT the same image; the new asset still uploaded). */
  possibleDuplicate: PossibleDuplicate | null;
}

/**
 * Compute pHash + dominant colors from an image buffer. Best-effort: any
 * decode/processing failure is swallowed and logged so the rest of the
 * upload pipeline continues unaffected.
 */
async function computePerceptualMetadata(
  buffer: Buffer,
  mimeType: string
): Promise<{ phash: bigint | null; colors: PaletteColor[] | null }> {
  if (!mimeType.startsWith("image/")) {
    return { phash: null, colors: null };
  }
  try {
    const [phash, colors] = await Promise.all([
      computePHash(buffer).catch(() => null),
      extractPalette(buffer).catch(() => null),
    ]);
    return { phash, colors };
  } catch (err) {
    console.warn("[fonto] perceptual metadata extraction failed:", err);
    return { phash: null, colors: null };
  }
}

/**
 * Find any existing image asset in the same workspace whose pHash is within
 * Hamming-distance threshold. Returns the first match (or null). Filters out
 * trashed/purged assets and the asset being uploaded itself.
 */
async function findPHashNearDuplicate(
  workspaceId: string,
  newPHash: bigint,
  excludeAssetId?: string
): Promise<{
  id: string;
  filename: string;
  capturedAt: string | null;
  createdAt: string;
  mimeType: string;
  distance: number;
} | null> {
  const candidates = await db
    .select({
      id: schema.assets.id,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      capturedAt: schema.assets.capturedAt,
      createdAt: schema.assets.createdAt,
      phash: schema.assets.phash,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        isNotNull(schema.assets.phash)
      )
    );

  let best: {
    id: string;
    filename: string;
    capturedAt: Date | null;
    createdAt: Date;
    mimeType: string;
    distance: number;
  } | null = null;
  for (const row of candidates) {
    if (row.phash == null) continue;
    if (excludeAssetId && row.id === excludeAssetId) continue;
    const d = hammingDistance(BigInt(row.phash), newPHash);
    if (d <= PHASH_DUPLICATE_THRESHOLD && (!best || d < best.distance)) {
      best = {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        capturedAt: row.capturedAt,
        createdAt: row.createdAt,
        distance: d,
      };
    }
  }
  if (!best) return null;
  return {
    id: best.id,
    filename: best.filename,
    mimeType: best.mimeType,
    capturedAt: best.capturedAt ? best.capturedAt.toISOString() : null,
    createdAt: best.createdAt.toISOString(),
    distance: best.distance,
  };
}

/**
 * Try to enqueue a thumbnail job, but don't crash the build if Phase 1.1
 * hasn't shipped the queue export yet. The import is dynamic + try/catch so a
 * missing symbol stays a runtime warning rather than a TS error.
 */
async function tryEnqueueThumbnail(assetId: string, workspaceId: string, mimeType: string): Promise<void> {
  if (!mimeType.startsWith("image/")) return;
  try {
    const mod = (await import("@/lib/queue")) as unknown as {
      thumbnailQueue?: () => { add: (n: string, p: unknown) => Promise<unknown> };
      JobNames?: Record<string, string>;
    };
    if (typeof mod.thumbnailQueue !== "function") return;
    const jobName = mod.JobNames?.GenerateThumbnails ?? "generate-thumbnails";
    await mod.thumbnailQueue().add(jobName, { assetId, workspaceId });
  } catch (err) {
    console.warn("[fonto] thumbnail enqueue skipped:", err);
  }
}

/**
 * Insert (or short-circuit-return existing) an asset row from an in-memory
 * buffer. Both `/api/v1/assets` (legacy multipart) and
 * `/api/v1/assets/:id/complete` (presigned PUT) funnel through here.
 */
export async function createAssetRow(input: CreateAssetInput): Promise<CreateAssetResult> {
  const { workspaceId, userId, userEmail, filename, mimeType, sizeBytes, buffer, source } = input;
  const sha256 = input.sha256 ?? createHash("sha256").update(buffer).digest("hex");

  // SHA-256 dedup: return existing non-purged asset if hash matches.
  const [duplicate] = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.sha256, sha256),
        eq(schema.assets.lifecycleState, "active")
      )
    )
    .limit(1);
  if (duplicate) {
    return { asset: duplicate, deduplicated: true, possibleDuplicate: null };
  }

  // Extract text from text/* files immediately.
  let extractedText: string | null = null;
  if (mimeType.startsWith("text/") && buffer.length < 500_000) {
    extractedText = buffer.toString("utf-8").slice(0, 10_000);
  }

  const { phash, colors } = await computePerceptualMetadata(buffer, mimeType);
  const exifData = await extractExif(buffer, mimeType);

  let possibleDuplicate: PossibleDuplicate | null = null;
  if (phash != null) {
    const match = await findPHashNearDuplicate(workspaceId, phash);
    if (match) {
      possibleDuplicate = {
        assetId: match.id,
        filename: match.filename,
        capturedAt: match.capturedAt,
        createdAt: match.createdAt,
        distance: match.distance,
        thumbUrl: `/api/v1/assets/${match.id}/url`,
      };
    }
    // Shadow-mode pHash NN against the FalkorDB index (ADR 0027). Read-only.
    if (fontoGraphConfigured()) {
      void (async () => {
        try {
          const graphMatch = await findNearestAssetByPhashGraph({
            workspaceId,
            phash,
            scoreThreshold: Math.sqrt(PHASH_DUPLICATE_THRESHOLD),
          });
          const pgId = match?.id ?? null;
          const gId = graphMatch?.assetId ?? null;
          if (pgId !== gId) {
            console.warn("[fonto-graph] phash NN disagreement", {
              workspaceId,
              postgres: pgId,
              graph: gId,
              graphScore: graphMatch?.score,
            });
          }
        } catch (err) {
          console.warn("[fonto-graph] shadow phash NN failed:", err);
        }
      })();
    }
  }

  // Phase 2.3 — allocate this row's delta-sync seq before insert so it
  // appears on the very first `/sync/assets` page after creation.
  const assetSeq = await nextSeq(workspaceId, "asset");

  const [asset] = await db
    .insert(schema.assets)
    .values({
      workspaceId,
      filename,
      mimeType,
      sizeBytes,
      sha256,
      seq: assetSeq,
      // The presigned-PUT path has already written the object to R2 before
      // calling here, so the row starts `synced`. The legacy multipart path
      // overrides this to `syncing` and flips to `synced` after its
      // PutObjectCommand completes — see the caller for that wrinkle.
      syncState: "synced",
      processingState: "captured",
      lifecycleState: "active",
      source,
      extractedText,
      capturedAt: exifData.capturedAt ?? new Date(),
      phash,
      colors,
      exif: exifData.raw,
      latitude: exifData.latitude,
      longitude: exifData.longitude,
      cameraMake: exifData.cameraMake,
      cameraModel: exifData.cameraModel,
      lensModel: exifData.lensModel,
      focalLength: exifData.focalLength,
      fNumber: exifData.fNumber,
      iso: exifData.iso,
      exposureTime: exifData.exposureTime,
      orientation: exifData.orientation,
      widthPx: exifData.widthPx,
      heightPx: exifData.heightPx,
      ocrState: mimeType.startsWith("image/") ? "pending" : "skipped",
    })
    .returning();

  // ext.fonto.asset.uploaded (fire-and-forget).
  void plexoPublishEvent("ext.fonto.asset.uploaded", {
    assetId: asset.id,
    filename,
    mimeType,
    sizeBytes,
    sha256,
    source,
  });

  // Enqueue main asset-processing pipeline.
  try {
    await assetProcessingQueue().add(JobNames.ProcessAsset, {
      assetId: asset.id,
      workspaceId,
      userId,
      email: userEmail ?? undefined,
      filename,
      mimeType,
      extractedText,
    });
  } catch (err) {
    console.error("[fonto] failed to enqueue process-asset job:", err);
  }

  // Phase 1.1 thumbnail enqueue — optional; resolved dynamically.
  await tryEnqueueThumbnail(asset.id, workspaceId, mimeType);

  // Phase D-Fonto-1 (ADR 0027): mirror to fonto graph for vector NN.
  if (phash != null && fontoGraphConfigured()) {
    void mirrorAssetToGraph({
      workspaceId,
      assetId: asset.id,
      filename,
      mimeType,
      lifecycleState: "active",
      phash,
    }).catch((err) => console.warn("[fonto-graph] asset mirror failed:", err));
  }

  assetIngestTotal.labels({ mime_class: classifyMime(mimeType) }).inc(1);

  return { asset, deduplicated: false, possibleDuplicate };
}

/**
 * JSON-safe asset serializer. Converts the native BigInt phash to string.
 */
export function serializeAsset<T extends { phash?: bigint | null }>(
  asset: T
): T & { phash: string | null } {
  return {
    ...asset,
    phash: asset.phash != null ? asset.phash.toString() : null,
  };
}
