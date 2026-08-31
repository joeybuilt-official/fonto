// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.1 — backfill thumbnail derivatives for assets that have none.
//
// Covers every mime type `generate-thumbnails` can actually render: images,
// videos (ffmpeg keyframe) and PDFs. It was image-only until 2026-08-30,
// which left 164 thumbnail-less videos and 5 PDFs permanently unreachable by
// the only tool an operator has for this — they render as a broken-image icon
// in the grid and nothing ever retries them. The mime set here must stay in
// step with `backfillReadyThumbnails()` in lib/processing/reapStuckAssets.ts,
// which sweeps the same three types.
//
// Behaviour: enqueues `generate-thumbnails` jobs on the BullMQ thumbnails
// queue and exits. The worker pool does the actual sharp encode + R2 PUT.
// Running this script back-to-back is safe — the predicate filters out rows
// whose `thumbnail_key` has already been populated, and the worker itself is
// idempotent for any row that slips through.
//
// Usage:
//   pnpm backfill:thumbnails                   # default batch=200
//   pnpm backfill:thumbnails -- --batch=100    # tune enqueue batch
//   pnpm backfill:thumbnails -- --dry-run      # print, don't enqueue
//
// Reads DATABASE_URL and REDIS_URL from env.

import postgres from "postgres";
import { Queue } from "bullmq";
import IORedis from "ioredis";

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
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://valkey:6379";

  const batchSize = Math.max(parseInt(String(arg("batch") ?? "200"), 10), 1);
  const dryRun = !!arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });
  // Use a one-shot ioredis client rather than the shared connection helper —
  // this script is short-lived and we want to close cleanly without touching
  // the app's connection cache.
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("thumbnails", { connection: redis });

  const stats = { enqueued: 0, scanned: 0, batches: 0 };
  console.log(
    `[backfill-thumbnails] start (batch=${batchSize}${dryRun ? ", dry-run" : ""})`
  );

  // Single-pass keyset paginate over (created_at, id) descending. We DO NOT
  // re-select on `thumbnail_key IS NULL` per batch because this script only
  // ENQUEUES — the worker writes `thumbnail_key` asynchronously. A naive
  // select-then-reselect loop re-enqueues every row every batch until the
  // worker drains, which is how a prior run ballooned to 1.7M jobs against
  // 35 actual rows. With `jobId: backfill-thumb:<id>` on each enqueue,
  // BullMQ dedupes re-runs while previous jobs are still in flight, so
  // it's safe to run this script back-to-back as new rows arrive.
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  for (;;) {
    const rows = (cursorCreatedAt && cursorId
      ? await sql`
          SELECT id, workspace_id, created_at::text AS created_at
          FROM fonto.assets
          WHERE lifecycle_state = 'active'
            AND (
              mime_type LIKE 'image/%'
              OR mime_type LIKE 'video/%'
              OR mime_type = 'application/pdf'
            )
            AND thumbnail_key IS NULL
            AND (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT ${batchSize}
        `
      : await sql`
          SELECT id, workspace_id, created_at::text AS created_at
          FROM fonto.assets
          WHERE lifecycle_state = 'active'
            AND (
              mime_type LIKE 'image/%'
              OR mime_type LIKE 'video/%'
              OR mime_type = 'application/pdf'
            )
            AND thumbnail_key IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ${batchSize}
        `) as unknown as Array<AssetRow & { created_at: string }>;

    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    if (dryRun) {
      for (const r of rows) {
        console.log(`[backfill-thumbnails] would enqueue ${r.id} ws=${r.workspace_id}`);
      }
    } else {
      await queue.addBulk(
        rows.map((r) => ({
          name: "generate-thumbnails",
          data: { assetId: r.id, workspaceId: r.workspace_id },
          opts: { jobId: `backfill-thumb-${r.id}` },
        }))
      );
    }
    stats.enqueued += rows.length;

    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;

    console.log(
      `[backfill-thumbnails] batch ${stats.batches} enqueued ${rows.length}; running total ${stats.enqueued}`
    );

    if (rows.length < batchSize) break;
  }

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
  console.log(`[backfill-thumbnails] complete: ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[backfill-thumbnails] fatal:", e);
  process.exit(1);
});
