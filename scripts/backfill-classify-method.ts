// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — re-enqueue every asset with `classify_method IS NULL` so
// the worker stamps the column. Pre-phase-4.6 rows never had it set;
// this lets us see classify path coverage everywhere without waiting
// for organic re-processing.
//
// Usage:
//   pnpm backfill:classify-method                          # all workspaces
//   pnpm backfill:classify-method -- --workspace=<uuid>
//   pnpm backfill:classify-method -- --dry-run
//   pnpm backfill:classify-method -- --limit=200
//
// Throttle: 200ms gap between enqueues so the Plexo authLimiter doesn't
// see a burst from the worker waking up on all of them at once.

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

interface Row {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  const workspaceFilter =
    typeof arg("workspace") === "string" ? (arg("workspace") as string) : null;
  const dryRun = !!arg("dry-run");
  const limitArg = arg("limit");
  const limit =
    typeof limitArg === "string" ? Number.parseInt(limitArg, 10) : Number.POSITIVE_INFINITY;
  const throttleMs = 200;

  const sql = postgres(dbUrl, { prepare: false });
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const processQueue = new Queue("asset-processing", { connection: redis });

  try {
    const rows = (workspaceFilter
      ? await sql`
          SELECT id, workspace_id, filename, mime_type
          FROM fonto.assets
          WHERE lifecycle_state = 'active'
            AND classify_method IS NULL
            AND workspace_id = ${workspaceFilter}
          ORDER BY created_at DESC
        `
      : await sql`
          SELECT id, workspace_id, filename, mime_type
          FROM fonto.assets
          WHERE lifecycle_state = 'active'
            AND classify_method IS NULL
          ORDER BY created_at DESC
        `) as unknown as Row[];

    const candidates = rows.slice(0, limit);
    console.log(
      `[backfill-classify-method] found ${rows.length} rows w/ classify_method=NULL; processing ${candidates.length} (dryRun=${dryRun})`
    );

    if (candidates.length === 0 || dryRun) {
      if (dryRun) {
        for (const r of candidates) {
          console.log(`  would enqueue ${r.id} (${r.filename})`);
        }
      }
      return;
    }

    // Workspace → user lookup so processAsset has a valid identity.
    const workspaceIds = Array.from(new Set(candidates.map((r) => r.workspace_id)));
    const wsRows = (await sql`
      SELECT id, user_id FROM fonto.workspaces WHERE id = ANY(${workspaceIds}::uuid[])
    `) as Array<{ id: string; user_id: string }>;
    const wsUser = new Map(wsRows.map((w) => [w.id, w.user_id]));

    const runId = Date.now().toString(36);
    let enqueued = 0;
    for (const r of candidates) {
      const userId = wsUser.get(r.workspace_id);
      if (!userId) {
        console.warn(`  skip ${r.id}: workspace ${r.workspace_id} has no user_id`);
        continue;
      }
      // Reset so the worker actually re-runs the classify pass.
      await sql`
        UPDATE fonto.assets
        SET processing_state = 'captured'
        WHERE id = ${r.id} AND processing_state = 'ready'
      `;
      await processQueue.add(
        "process-asset",
        {
          assetId: r.id,
          workspaceId: r.workspace_id,
          userId,
          filename: r.filename,
          mimeType: r.mime_type,
          extractedText: null,
        },
        { jobId: `backfill-classify-${runId}-${r.id}` }
      );
      enqueued++;
      if (enqueued % 10 === 0) {
        console.log(`  enqueued ${enqueued}/${candidates.length}…`);
      }
      await new Promise((res) => setTimeout(res, throttleMs));
    }
    console.log(`[backfill-classify-method] enqueued ${enqueued}/${candidates.length}`);
  } finally {
    await processQueue.close();
    redis.disconnect();
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[backfill-classify-method] fatal:", err);
  process.exit(1);
});
