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
  created_at: string;
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

  // Single-pass keyset paginate over (created_at, id) descending. We DO NOT
  // re-select on `clip_vec IS NULL` per batch (despite the predicate below)
  // because this script only ENQUEUES — the worker writes `clip_vec`
  // asynchronously. A naive select-then-reselect loop re-enqueues every row
  // every batch until the worker drains, which is how backfill-thumbnails
  // ballooned to 1.7M jobs against 35 actual rows. With
  // `jobId: backfill-clip-<id>` on each enqueue, BullMQ dedupes re-runs
  // while previous jobs are still in flight, so back-to-back runs are safe.
  //
  // The `clip_vec` column lands with phase 4.3. If it isn't there yet, the
  // query throws 42703; catch and bail out with a clear message rather than
  // a stack trace so operators know which migration is missing.
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  for (;;) {
    let rows: AssetRow[];
    try {
      rows = (cursorCreatedAt && cursorId
        ? await sql`
            SELECT id, workspace_id, created_at::text AS created_at
            FROM fonto.assets
            WHERE lifecycle_state = 'active'
              AND mime_type LIKE 'image/%'
              AND clip_vec IS NULL
              AND (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
            ORDER BY created_at DESC, id DESC
            LIMIT ${batchSize}
          `
        : await sql`
            SELECT id, workspace_id, created_at::text AS created_at
            FROM fonto.assets
            WHERE lifecycle_state = 'active'
              AND mime_type LIKE 'image/%'
              AND clip_vec IS NULL
            ORDER BY created_at DESC, id DESC
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
    } else {
      await queue.addBulk(
        rows.map((r) => ({
          name: "embed-asset",
          data: { assetId: r.id, workspaceId: r.workspace_id },
          opts: { jobId: `backfill-clip-${r.id}` },
        }))
      );
    }
    stats.enqueued += rows.length;

    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;

    console.log(
      `[backfill-clip] batch ${stats.batches} enqueued ${rows.length}; running total ${stats.enqueued}`
    );

    if (rows.length < batchSize) break;
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
