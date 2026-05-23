// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.2 — backfill CLIP image embeddings for image assets uploaded
// before Phase 4.2 shipped (or for any row whose `clip_vec` is NULL).
//
// Behaviour: enqueues `embed-asset` jobs on the BullMQ `clip-embedding`
// queue and exits. The worker pool does the actual vision call + DB write.
// Re-running is safe — the WHERE predicate excludes rows that already have
// a non-NULL `clip_vec`, and the worker itself is idempotent.
//
// Usage:
//   pnpm backfill:clip                   # default batch=200
//   pnpm backfill:clip -- --batch=100    # tune enqueue batch
//   pnpm backfill:clip -- --dry-run      # print, don't enqueue
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
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("clip-embedding", { connection: redis });

  const stats = { enqueued: 0, scanned: 0, batches: 0 };
  console.log(
    `[backfill-clip] start (batch=${batchSize}${dryRun ? ", dry-run" : ""})`
  );

  // The `clip_vec` column lands with phase 4.3. If it isn't there yet, the
  // query throws 42703; catch and bail out with a clear message rather than
  // a stack trace so operators know which migration is missing.
  // Scan newest-first so the most-likely-to-be-searched assets get embedded
  // first. The IS NULL predicate naturally shrinks the working set each pass.
  while (true) {
    let rows: AssetRow[];
    try {
      rows = (await sql`
        SELECT id, workspace_id
        FROM fonto.assets
        WHERE lifecycle_state = 'active'
          AND mime_type LIKE 'image/%'
          AND clip_vec IS NULL
        ORDER BY created_at DESC
        LIMIT ${batchSize}
      `) as unknown as AssetRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/clip_vec|undefined column|42703/i.test(msg)) {
        console.error(
          "[backfill-clip] fonto.assets.clip_vec column missing — apply phase 4.3 migration before running this backfill"
        );
        await queue.close();
        redis.disconnect();
        await sql.end({ timeout: 5 });
        process.exit(2);
      }
      throw err;
    }

    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    if (dryRun) {
      for (const r of rows) {
        console.log(`[backfill-clip] would enqueue ${r.id} ws=${r.workspace_id}`);
      }
      // Dry-run never writes — break after first batch or we loop forever.
      break;
    }

    await queue.addBulk(
      rows.map((r) => ({
        name: "embed-asset",
        data: { assetId: r.id, workspaceId: r.workspace_id },
      }))
    );
    stats.enqueued += rows.length;

    console.log(
      `[backfill-clip] batch ${stats.batches} enqueued ${rows.length}; running total ${stats.enqueued}`
    );
  }

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
  console.log(`[backfill-clip] complete: ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[backfill-clip] fatal:", e);
  process.exit(1);
});
