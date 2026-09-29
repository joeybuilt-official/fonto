// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — re-enqueue a single asset through the worker's processAsset
// pipeline. Use for nudge-tests + ad-hoc reprocessing.
//
// Unlike POST /api/v1/assets/:id/reprocess (which inlines a lightweight
// classify+describe call against the AI tier), this script enqueues the full
// asset-processing job that runs the worker's processAsset — so all the
// downstream side effects fire: classify_method, sub_classification,
// face detection, CLIP embedding, OCR, etc.
//
// Usage:
//   pnpm reprocess:one -- --asset=<uuid> [--no-thumb]
//
// Reads DATABASE_URL + REDIS_URL from env. Workspace + user are looked up
// from the asset row.

import postgres from "postgres";
import IORedis from "ioredis";
import { Queue } from "bullmq";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

interface AssetRow {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
  thumbnail_key: string | null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  const assetId = arg("asset");
  if (typeof assetId !== "string" || !assetId) {
    throw new Error("--asset=<uuid> required");
  }
  const skipThumb = !!arg("no-thumb");

  const sql = postgres(dbUrl, { prepare: false });
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const processQueue = new Queue("asset-processing", { connection: redis });
  const thumbQueue = new Queue("thumbnail", { connection: redis });

  try {
    const rows = (await sql`
      SELECT id, workspace_id, filename, mime_type, thumbnail_key
      FROM fonto.assets
      WHERE id = ${assetId}
      LIMIT 1
    `) as unknown as AssetRow[];
    if (rows.length === 0) {
      throw new Error(`asset ${assetId} not found`);
    }
    const asset = rows[0];

    const [ws] = (await sql`
      SELECT user_id FROM fonto.workspaces WHERE id = ${asset.workspace_id}
    `) as Array<{ user_id: string }>;
    if (!ws) {
      throw new Error(`workspace ${asset.workspace_id} has no user_id`);
    }

    // Reset processing_state so the worker runs the full classify pass.
    // classify_method + sub_classification are NULL'd so the result is
    // unambiguously from this run.
    await sql`
      UPDATE fonto.assets
      SET processing_state = 'captured',
          classify_method = NULL,
          sub_classification = NULL
      WHERE id = ${assetId}
    `;

    const runId = Date.now().toString(36);
    await processQueue.add(
      "process-asset",
      {
        assetId: asset.id,
        workspaceId: asset.workspace_id,
        userId: ws.user_id,
        filename: asset.filename,
        mimeType: asset.mime_type,
        extractedText: null,
      },
      { jobId: `reprocess-one-${runId}-${asset.id}` }
    );

    if (!skipThumb && !asset.thumbnail_key) {
      await thumbQueue.add(
        "thumbnail",
        { assetId: asset.id, workspaceId: asset.workspace_id },
        { jobId: `reprocess-one-thumb-${runId}-${asset.id}` }
      );
    }

    console.log(`[reprocess-one] enqueued ${asset.filename} (${assetId})`);
  } finally {
    await processQueue.close();
    await thumbQueue.close();
    redis.disconnect();
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[reprocess-one] fatal:", err);
  process.exit(1);
});
