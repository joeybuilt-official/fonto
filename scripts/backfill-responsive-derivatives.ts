// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// T2.3c (docs/claude/platform/completed/perf-audit/perf-audit-plan.md) — backfill responsive derivative tiers for
// image assets ingested before T2.3a + T2.3b shipped the 6 new columns:
//   thumbnail_256_avif_key
//   thumbnail_512_webp_key, thumbnail_512_avif_key
//   thumbnail_1024_webp_key, thumbnail_1024_avif_key
//   preview_avif_key
//
// Rationale: responsive srcset + AVIF cuts grid-tile bandwidth and improves
// LCP on the library/timeline views. Worker pipeline
// (lib/processing/generateThumbnails.ts) already emits all six on fresh
// ingest; this script just enqueues `generate-thumbnails` jobs for legacy
// rows so the worker pool re-encodes them.
//
// Behaviour: enqueues `generate-thumbnails` jobs on the BullMQ `thumbnails`
// queue and exits. The worker pool does the actual sharp encode + R2 PUT.
// Safe to re-run — the SQL predicate excludes rows where the new tiers are
// already populated, and the worker pipeline writes content-addressed R2
// keys so re-encoding the same source is idempotent. `force: true` is set
// on each job payload to signal the worker should re-run even if
// `thumbnail_key` is already non-null.
//
// Usage:
//   pnpm backfill:responsive                          # default batch=200
//   pnpm backfill:responsive -- --batch=100           # tune enqueue batch
//   pnpm backfill:responsive -- --dry-run             # print, don't enqueue
//   pnpm backfill:responsive -- --max=500             # cap total enqueues
//   pnpm backfill:responsive -- --resume-from=<uuid>  # resume from cursor
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

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  const batchSize = Math.max(parseInt(String(arg("batch") ?? "200"), 10), 1);
  const dryRun = !!arg("dry-run");
  const maxArg = arg("max");
  const maxEnqueue =
    maxArg && maxArg !== true ? Math.max(parseInt(String(maxArg), 10), 1) : Infinity;
  const resumeFromArg = arg("resume-from");
  let cursor =
    resumeFromArg && resumeFromArg !== true ? String(resumeFromArg) : ZERO_UUID;

  const sql = postgres(dbUrl, { prepare: false });
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("thumbnails", { connection: redis });

  const stats = { enqueued: 0, scanned: 0, batches: 0 };
  console.log(
    `[backfill-responsive] start (batch=${batchSize}${
      dryRun ? ", dry-run" : ""
    }, max=${maxEnqueue === Infinity ? "unlimited" : maxEnqueue}, cursor=${cursor})`
  );

  for (;;) {
    if (stats.enqueued >= maxEnqueue) break;

    const remaining = maxEnqueue - stats.enqueued;
    const limit = Math.min(batchSize, remaining);

    const rows = (await sql`
      SELECT id, workspace_id
      FROM fonto.assets
      WHERE lifecycle_state = 'active'
        AND thumbnail_key IS NOT NULL
        AND (
          thumbnail_512_webp_key IS NULL
          OR thumbnail_1024_webp_key IS NULL
          OR thumbnail_256_avif_key IS NULL
        )
        AND id > ${cursor}::uuid
      ORDER BY id ASC
      LIMIT ${limit}
    `) as unknown as AssetRow[];

    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    if (dryRun) {
      for (const r of rows) {
        console.log(
          `[backfill-responsive] would enqueue ${r.id} ws=${r.workspace_id}`
        );
      }
    } else {
      await queue.addBulk(
        rows.map((r) => ({
          name: "generate-thumbnails",
          data: { assetId: r.id, workspaceId: r.workspace_id, force: true },
          opts: { jobId: `backfill-responsive-${r.id}` },
        }))
      );
    }
    stats.enqueued += rows.length;

    const last = rows[rows.length - 1];
    cursor = last.id;

    if (stats.enqueued % 200 === 0 || rows.length < limit) {
      console.log(
        `[backfill-responsive] enqueued=${stats.enqueued} cursor=${cursor}`
      );
    }

    if (rows.length < limit) break;
  }

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
  console.log(
    `[backfill-responsive] complete: total=${stats.enqueued} last-cursor=${cursor} ${JSON.stringify(
      stats
    )}`
  );
}

main().catch((e) => {
  console.error("[backfill-responsive] fatal:", e);
  process.exit(1);
});
