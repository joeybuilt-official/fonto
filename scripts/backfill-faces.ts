// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — backfill face detection + ArcFace embedding for image assets
// uploaded before plexo-vision's `apps/vision` shipped (Phase 4.2 deploy),
// or for any row that has no `face_instances` rows yet.
//
// Behaviour: enqueues `face-detect` jobs on the BullMQ `face-detect` queue
// and exits. The worker pool does the actual vision call + DB write. The
// face-detect worker is NOT idempotent at the DB layer — every run inserts
// new `face_instances` rows for the same asset. We guard against duplicate
// enqueues by selecting only assets with ZERO existing face_instances rows
// (NOT NULL embedding count), and by pinning `jobId: backfill-faces-<id>`
// so BullMQ dedupes in-flight retries within a single run.
//
// Usage:
//   pnpm backfill:faces                   # default batch=200
//   pnpm backfill:faces -- --batch=100    # tune enqueue batch
//   pnpm backfill:faces -- --dry-run      # print, don't enqueue
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
  const queue = new Queue("face-detect", { connection: redis });

  const stats = { enqueued: 0, scanned: 0, batches: 0 };
  console.log(
    `[backfill-faces] start (batch=${batchSize}${dryRun ? ", dry-run" : ""})`
  );

  // Keyset paginate over (created_at, id) descending. We anti-join on
  // face_instances rather than re-selecting per batch — the worker is
  // async, and a select-then-reselect loop would re-enqueue every row
  // every batch until the worker drains (the bug pattern fixed at
  // commit 65cd906). With `jobId: backfill-faces-<id>` each enqueue,
  // BullMQ dedupes within an in-flight run.
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  for (;;) {
    let rows: AssetRow[];
    try {
      rows = (cursorCreatedAt && cursorId
        ? await sql`
            SELECT a.id, a.workspace_id, a.created_at::text AS created_at
            FROM fonto.assets a
            LEFT JOIN fonto.face_instances fi ON fi.asset_id = a.id
            WHERE a.lifecycle_state = 'active'
              AND a.mime_type LIKE 'image/%'
              AND (a.created_at, a.id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
            GROUP BY a.id, a.workspace_id, a.created_at
            HAVING COUNT(fi.id) = 0
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ${batchSize}
          `
        : await sql`
            SELECT a.id, a.workspace_id, a.created_at::text AS created_at
            FROM fonto.assets a
            LEFT JOIN fonto.face_instances fi ON fi.asset_id = a.id
            WHERE a.lifecycle_state = 'active'
              AND a.mime_type LIKE 'image/%'
            GROUP BY a.id, a.workspace_id, a.created_at
            HAVING COUNT(fi.id) = 0
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ${batchSize}
          `) as unknown as AssetRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/face_instances|undefined column|42703|42P01/i.test(msg)) {
        console.error(
          "[backfill-faces] fonto.face_instances missing — apply phase 5.1 migration (0021_faces_persons.sql) before running"
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
        console.log(
          `[backfill-faces] would enqueue ${r.id} ws=${r.workspace_id}`
        );
      }
    } else {
      await queue.addBulk(
        rows.map((r) => ({
          name: "face-detect",
          data: { assetId: r.id },
          opts: { jobId: `backfill-faces-${r.id}` },
        }))
      );
    }
    stats.enqueued += rows.length;

    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;

    console.log(
      `[backfill-faces] batch ${stats.batches} enqueued ${rows.length}; running total ${stats.enqueued}`
    );

    if (rows.length < batchSize) break;
  }

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
  console.log(`[backfill-faces] complete: ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[backfill-faces] fatal:", e);
  process.exit(1);
});
