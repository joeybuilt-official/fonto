// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.2 — CLIP image embedding for a single asset.
//
// Pulled into its own file so the worker handler stays small and so a future
// reprocess CLI (e.g. `pnpm reembed:asset <id>`) can call this directly.
//
// Behaviour:
//   - Loads the asset row + workspace from Postgres.
//   - Skips silently for non-image MIME types (this lets us enqueue from a
//     producer that doesn't yet know the type).
//   - Prefers the 1080px preview derivative (small, already decoded) so the
//     vision service doesn't burn cycles re-decoding a RAW. Falls back to
//     the original if the preview hasn't been generated yet.
//   - Calls `embedImage()` and writes `assets.clip_vec` via raw SQL — the
//     Drizzle schema column lands with the 4.3 pgvector migration; until then
//     this path is gated by `intelligence.available("embedImage")` and short-circuits when the
//     column is missing (the SQL fails cleanly).
//
// Graceful degradation: the caller (worker) catches throws and BullMQ retries
// per the queue's policy. A persistently-failing vision service eventually
// exhausts attempts and the job lands in DLQ — uploads themselves are
// unaffected.

import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { intelligence } from "@/lib/intelligence/client";
import { visionNeedsPreview } from "@/lib/mime";

export interface EmbedAssetInput {
  assetId: string;
  workspaceId: string;
}

export interface EmbedAssetResult {
  skipped: boolean;
  reason?:
    | "non-image"
    | "asset-missing"
    | "no-r2-bucket"
    | "vision-not-configured"
    | "clip-column-missing"
    | "preview-not-ready";
  modelId?: string;
  dimensions?: number;
}

async function downloadFromR2(bucket: string, key: string): Promise<Buffer> {
  return storage().getBuffer(key);
}

/** Format `number[]` as a pgvector literal `[0.1,0.2,...]`. */
function toPgVectorLiteral(vec: number[]): string {
  // No spaces — keeps the wire payload smaller and pgvector accepts both.
  return `[${vec.join(",")}]`;
}

export async function embedAsset(
  input: EmbedAssetInput
): Promise<EmbedAssetResult> {
  const { assetId, workspaceId } = input;
  const log = logger.child({ component: "clip-embed", assetId, workspaceId });

  if (!intelligence.available("embedImage")) {
    log.info("vision service not configured — skipping");
    return { skipped: true, reason: "vision-not-configured" };
  }

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    log.error("R2_BUCKET unset — cannot embed asset");
    return { skipped: true, reason: "no-r2-bucket" };
  }

  const [asset] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);

  if (!asset) {
    log.warn("asset row missing");
    return { skipped: true, reason: "asset-missing" };
  }

  if (!asset.mimeType.startsWith("image/")) {
    log.info({ mimeType: asset.mimeType }, "non-image asset — skipping");
    return { skipped: true, reason: "non-image" };
  }

  // E4-M6 — if this container needs the sharp-decoded preview and the preview
  // has not been generated yet, skip. The vision model cannot decode a RAW /
  // HEIC / AVIF original, so there is no fallback worth attempting — the row
  // is re-covered by `backfill:clip` once its thumbnail lands (the same
  // accepted gap as the `skipped` thumbnail rows B2 measured). Decodable
  // mimes (JPEG/PNG/…) keep the `previewKey ?? original` fallback.
  if (visionNeedsPreview(asset.mimeType) && !asset.previewKey) {
    log.info(
      { mimeType: asset.mimeType },
      "preview-required mime without a generated preview — skipping embed"
    );
    return { skipped: true, reason: "preview-not-ready" };
  }

  // Prefer preview (1080px WebP) — small, web-safe, already decoded by sharp.
  // Falls back to original which the vision service must decode itself.
  const key = asset.previewKey ?? assetStorageKey(workspaceId, assetId, asset.filename);
  const buffer = await downloadFromR2(bucket, key);
  log.info({ bytes: buffer.length, key }, "downloaded image for embedding");

  const { vector, modelId } = await intelligence.embedImage(
    buffer.toString("base64"),
    asset.mimeType
  );
  log.info({ modelId, dims: vector.length }, "embedding received");

  // TODO(4.3): once migration 0017 lands and `schema.assets.clipVec` exists,
  // switch this raw write to the typed column update. For now we go through
  // raw SQL so this code can ship alongside (or just ahead of) the migration.
  // If the column doesn't yet exist, the UPDATE throws a 42703 and the
  // worker retries — eventually the migration ships and the retry succeeds.
  try {
    const literal = toPgVectorLiteral([...vector]);
    await db.execute(
      sql`UPDATE fonto.assets SET clip_vec = ${literal}::vector WHERE id = ${assetId}::uuid`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 42703 = undefined_column. Means migration 0017 hasn't landed in this
    // environment. Surface that as a skip rather than a hard failure so the
    // worker doesn't exhaust retries against a known-missing column.
    if (/clip_vec|undefined column|42703/i.test(msg)) {
      log.warn({ err: msg }, "assets.clip_vec column missing — phase 4.3 not landed");
      return { skipped: true, reason: "clip-column-missing", modelId, dimensions: vector.length };
    }
    throw err;
  }

  return {
    skipped: false,
    modelId,
    dimensions: vector.length,
  };
}
