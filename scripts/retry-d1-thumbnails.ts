// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// D1 follow-up (2026-09-13) — retry thumbnails for the rows the D1 incident
// parked as `thumbnail_state='failed'` with `thumbnail_error = 'The specified
// key does not exist.'`.
//
// `retry-c1-thumbnail-fixes.ts` deliberately EXCLUDES this class (its
// predicate is `NOT ILIKE '%specified key does not exist%'`) because at C1
// time (2026-09-09 AM) those originals were still missing from R2 and any
// retry would just re-derive the same error. D1 then recovered 13 of the 18
// (commit f137db133: copied the byte-exact originals from
// `_laptop-import-2026-07-05/Canon/` staging to the canonical local mirror,
// pushed to R2 via the storage facade, stamped `local_original_stored_at`);
// the other 5 (PNGs) were soft-deleted (`lifecycle_state='trashed'`). So
// today's predicate — still-failed + missing-key + `lifecycle_state='active'`
// — matches exactly the 13 now-recoverable rows and no others.
//
// Verified live (2026-09-13) before running: the 22-row `failed` population
// breaks down as 13 active quicktime with the missing-key error (this retry),
// 5 trashed PNGs, 3 pre-instrumentation blank-error trashed rows, and 1
// genuine h264 `exit 69` residual (`53d50080`) that C1 deliberately left.
//
// Retry mechanism mirrors `retry-c1-thumbnail-fixes.ts`: BullMQ refuses an
// `add` whose jobId exists in ANY set, including `failed`, so the retained
// terminal job for each row must be reclaimed first or the re-add is a
// silent no-op. Two deterministic jobIds are tried per row
// (`backfill-thumb-<id>`, `reap-thumb-<id>`); `queue.remove()` returns 0 for
// an id that isn't present, so trying both is safe. The worker stamps
// `thumbnail_state` itself on completion — this script does not write state.
//
// Usage:
//   pnpm tsx scripts/retry-d1-thumbnails.ts             # applies
//   pnpm tsx scripts/retry-d1-thumbnails.ts --dry-run   # print only
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
      AND thumbnail_error ILIKE '%specified key does not exist%'
      AND lifecycle_state = 'active'
  `) as unknown as FailedRow[];

  console.log(
    `[retry-d1-thumbnails] ${rows.length} row(s) match the D1-retry predicate` +
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
    `[retry-d1-thumbnails] reclaimed ${reclaimed}/${rows.length} retained terminal jobs; ` +
      `re-added ${rows.length}`
  );

  await queue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("[retry-d1-thumbnails] fatal:", e);
  process.exit(1);
});