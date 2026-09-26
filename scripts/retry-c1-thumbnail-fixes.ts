// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase C1 deploy follow-up (2026-09-09) — retry ONLY the rows the real
// ffmpeg fix in `extractVideoThumbnail.ts` addresses, after the worker
// carrying that fix is deployed and confirmed running.
//
// `thumbnail_state='failed'` today holds three disjoint populations:
//   - 131 video rows whose only cause was the ffmpeg mjpeg-encoder /
//     stream-map / seek-past-EOF bug — these are what this script retries.
//   - 18 D1 rows: `The specified key does not exist.` — the ORIGINAL is
//     gone from R2, not a decode failure. No fix landed for these; touching
//     them here would just burn a worker cycle re-deriving the same error.
//   - A handful of pre-instrumentation rows with an empty `thumbnail_error`
//     — no evidence to classify from; left untouched, not guessed at.
// `scripts/reclassify-permanent-thumbnail-failures.ts` already moved the
// 100 genuinely-undecodable rows (corrupt JPEG, truncated PSD, etc.) to
// `thumbnail_state='skipped'` — this script's predicate does not need to
// re-exclude those by pattern, only by being narrower than "all failed".
//
// Predicate: `thumbnail_state='failed' AND thumbnail_error IS NOT NULL AND
// thumbnail_error <> '' AND thumbnail_error NOT ILIKE '%specified key does
// not exist%'`. That is exactly "has a real, non-D1, non-blank reason" —
// the 131 ffmpeg rows are the only class left matching it once the 100
// skip-reclassification has run.
//
// Retry mechanism mirrors `backfill-thumbnails.ts`'s 2026-09-01 fix: BullMQ
// refuses an `add` whose jobId already exists in ANY set, including
// `failed`, so the retained terminal job for each row must be reclaimed
// first or the re-add is a silent no-op. Two deterministic jobIds are tried
// per row (`backfill-thumb-<id>` from the last backfill pass, `reap-thumb-
// <id>` from the stuck-asset reaper) — `queue.remove()` returns 0 and does
// not throw for an id that isn't present, so trying both is safe.
//
// Idempotent: does NOT write `thumbnail_state` itself (the worker does,
// on job completion/failure) — re-running before the worker has drained
// the queue just re-reclaims+re-adds the same still-`failed` rows.
//
// Usage:
//   pnpm tsx scripts/retry-c1-thumbnail-fixes.ts             # applies
//   pnpm tsx scripts/retry-c1-thumbnail-fixes.ts --dry-run   # print only
//
// Reads DATABASE_URL and REDIS_URL from env. Run from inside a Fonto
// container (worker or app) so both resolve to the real services.

import postgres from "postgres";
import { Queue } from "bullmq";
import IORedis from "ioredis";

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface FailedRow {
  id: string;
  workspace_id: string;
  thumbnail_error: string | null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const dryRun = arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });

  const rows = (await sql`
    SELECT id, workspace_id, thumbnail_error
    FROM fonto.assets
    WHERE thumbnail_state = 'failed'
      AND thumbnail_error IS NOT NULL
      AND thumbnail_error <> ''
      AND thumbnail_error NOT ILIKE '%specified key does not exist%'
  `) as unknown as FailedRow[];

  console.log(
    `[retry-c1-thumbnail-fixes] ${rows.length} row(s) match the C1 predicate` +
      (dryRun ? " (dry-run, no writes)" : "")
  );

  if (dryRun) {
    for (const r of rows) {
      console.log(`  would retry ${r.id}: ${(r.thumbnail_error ?? "").slice(0, 80)}`);
    }
    await sql.end({ timeout: 5 });
    return;
  }

  if (rows.length === 0) {
    await sql.end({ timeout: 5 });
    return;
  }

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("thumbnails", { connection: redis });

  let reclaimed = 0;
  for (const r of rows) {
    const results = await Promise.allSettled([
      queue.remove(`backfill-thumb-${r.id}`),
      queue.remove(`reap-thumb-${r.id}`),
    ]);
    if (results.some((o) => o.status === "fulfilled" && o.value === 1)) {
      reclaimed += 1;
    }
  }

  await queue.addBulk(
    rows.map((r) => ({
      name: "generate-thumbnails",
      data: { assetId: r.id, workspaceId: r.workspace_id },
      opts: { jobId: `backfill-thumb-${r.id}` },
    }))
  );

  console.log(
    `[retry-c1-thumbnail-fixes] reclaimed ${reclaimed}/${rows.length} retained terminal jobs; ` +
      `re-added ${rows.length}`
  );

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("[retry-c1-thumbnail-fixes] fatal:", e);
  process.exit(1);
});
