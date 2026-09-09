// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// C3 (2026-09-09) — reset + retry the 29 `hls_state='failed'` rows this
// session's investigation classified as recoverable, out of the live 30.
//
//   - 15 rows: the D1 incident (`NoSuchKey`, video/quicktime, all inside
//     2026-07-06 05:07-07:13Z, `sync_state='error'`). Their originals are
//     now recovered (D1, commit f137db133 — `local_original_stored_at`
//     stamped, bytes in R2). No code fix needed, just reset + re-enqueue.
//   - 14 rows: R2 connect-timeout (`socket did not establish ... within
//     3000 ms`) — 10 in the same 2026-07-06 window, 4 more on 2026-07-07.
//     Fixed by raising `DEFAULT_CONNECTION_TIMEOUT_MS` in lib/r2.ts; MUST
//     NOT run this script until that fix is deployed and verified running.
//
// Left untouched: 1 row (2026-06-18, clock-skew `failedReason`) — an
// isolated, unrelated incident. Not in either group above.
//
// Predicate: `hls_state = 'failed' AND created_at >= '2026-07-06' AND
// created_at < '2026-07-08'`. `created_at` is what's evidenced against the
// live incident windows — `updated_at` is NOT: it drifts on every unrelated
// touch to the row (this session's own earlier Phase B1/B2/C1 backfills
// bumped `updated_at` on many of these same assets), so it undercounts.
// Verified live against prod (2026-09-09): all 29 recoverable rows carry
// `created_at` inside 2026-07-06T05:06:58Z-2026-07-07T20:04:47Z; the lone
// 2026-06-18 clock-skew outlier falls well outside it. No `hls_error`
// column exists to filter on (BullMQ `failedReason` lives in Redis, not
// Postgres) — the date window is the exact, evidenced boundary from the C3
// investigation (worklog 2026-09-09 finding(C3)). Dry-run before applying
// and confirm the count is 29 and none is the known outlier.
//
// Retry mechanism: unlike thumbnails, `addVideoHlsTranscodeJob` never pins a
// jobId (see lib/queue/queues.ts) — BullMQ assigns each add() a fresh
// auto-generated id, so there is no retained-terminal-job to reclaim before
// re-adding. Reset each matched row's `hls_state` to 'idle' (the pre-
// transcode state `app/api/v1/assets/[id]/hls/route.ts` enqueues from) and
// add a fresh job.
//
// Usage:
//   pnpm tsx scripts/retry-c3-hls-failures.ts             # applies
//   pnpm tsx scripts/retry-c3-hls-failures.ts --dry-run   # print only
//
// Reads DATABASE_URL and REDIS_URL from env. Run from inside a Fonto
// container (worker or app) so both resolve to the real services.

import postgres from "postgres";
import { Queue } from "bullmq";
import IORedis from "ioredis";

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface FailedHlsRow {
  id: string;
  workspace_id: string;
  mime_type: string;
  sync_state: string;
  created_at: Date;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://valkey:6379";
  const dryRun = arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });

  const rows = (await sql`
    SELECT id, workspace_id, mime_type, sync_state, created_at
    FROM fonto.assets
    WHERE hls_state = 'failed'
      AND created_at >= '2026-07-06'
      AND created_at < '2026-07-08'
  `) as unknown as FailedHlsRow[];

  console.log(
    `[retry-c3-hls-failures] ${rows.length} row(s) match the C3 predicate` +
      (dryRun ? " (dry-run, no writes)" : "")
  );

  if (dryRun) {
    for (const r of rows) {
      console.log(
        `  would retry ${r.id}: mime=${r.mime_type} sync_state=${r.sync_state} created_at=${r.created_at.toISOString()}`
      );
    }
    await sql.end({ timeout: 5 });
    return;
  }

  if (rows.length === 0) {
    await sql.end({ timeout: 5 });
    return;
  }

  await sql`
    UPDATE fonto.assets
    SET hls_state = 'idle'
    WHERE id = ANY(${rows.map((r) => r.id)})
      AND hls_state = 'failed'
  `;

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("video-hls-transcode", { connection: redis });

  await queue.addBulk(
    rows.map((r) => ({
      name: "video-hls-transcode",
      data: { assetId: r.id, workspaceId: r.workspace_id },
    }))
  );

  console.log(
    `[retry-c3-hls-failures] reset ${rows.length} row(s) to hls_state='idle' and enqueued ${rows.length} transcode job(s)`
  );

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("[retry-c3-hls-failures] fatal:", e);
  process.exit(1);
});
