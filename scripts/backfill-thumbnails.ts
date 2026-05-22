// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.1 — backfill thumbnail derivatives for image assets uploaded
// before Phase 1.1 shipped.
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

  // Scan in descending creation order so the most recently uploaded (the most
  // visible to users) get thumbnails first. The NULL predicate shrinks the
  // working set each pass, so a re-run after Ctrl-C resumes naturally.
  while (true) {
    const rows = (await sql`
      SELECT id, workspace_id
      FROM fonto.assets
      WHERE lifecycle_state = 'active'
        AND mime_type LIKE 'image/%'
        AND thumbnail_key IS NULL
      ORDER BY created_at DESC
      LIMIT ${batchSize}
    `) as unknown as AssetRow[];

    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    if (dryRun) {
      for (const r of rows) {
        console.log(`[backfill-thumbnails] would enqueue ${r.id} ws=${r.workspace_id}`);
      }
      // In dry-run mode we'd loop forever (no writes shrink the set). Break
      // after the first batch.
      break;
    }

    await queue.addBulk(
      rows.map((r) => ({
        name: "generate-thumbnails",
        data: { assetId: r.id, workspaceId: r.workspace_id },
      }))
    );
    stats.enqueued += rows.length;

    console.log(
      `[backfill-thumbnails] batch ${stats.batches} enqueued ${rows.length}; running total ${stats.enqueued}`
    );
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
