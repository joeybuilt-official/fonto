// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — re-enqueue assets that never made it past upload finalize.
//
// Some assets land in `processing_state='captured'` and never advance
// because the worker wasn't running when they were uploaded, or the
// enqueue call failed silently. These rows have no thumbnail, no
// clip_vec, no classification — and the UI pulses them yellow forever
// (see app/(app)/app/_components/photo-card.tsx :: `isProcessing`).
//
// This script finds them and pushes a fresh `process-asset` job onto
// the AssetProcessing queue. processAsset will set the state to
// 'ready' on completion. Thumbnail + face-detect + clip jobs are also
// re-enqueued so partially-processed rows finish.
//
// Usage:
//   pnpm reprocess:stuck                         # default: workspace=all
//   pnpm reprocess:stuck -- --workspace=<uuid>
//   pnpm reprocess:stuck -- --dry-run
//
// Reads DATABASE_URL + REDIS_URL from env.

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

interface StuckRow {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
  thumbnail_key: string | null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const redisUrl = process.env.REDIS_URL ?? "redis://valkey:6379";

  const workspaceFilter =
    typeof arg("workspace") === "string" ? (arg("workspace") as string) : null;
  const dryRun = !!arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const processQueue = new Queue("asset-processing", { connection: redis });
  const thumbQueue = new Queue("thumbnail", { connection: redis });

  // "Stuck" = either still at 'captured', or 'ready' without a thumbnail.
  // The latter is the half-processed case where the row went 'ready' before
  // the thumbnail worker existed / ran.
  const rows = (workspaceFilter
    ? await sql`
        SELECT a.id, a.workspace_id, a.filename, a.mime_type, a.thumbnail_key
        FROM fonto.assets a
        WHERE a.lifecycle_state = 'active'
          AND a.workspace_id = ${workspaceFilter}
          AND (
            a.processing_state = 'captured'
            OR (a.processing_state = 'ready' AND a.thumbnail_key IS NULL)
          )
        ORDER BY a.created_at DESC
      `
    : await sql`
        SELECT a.id, a.workspace_id, a.filename, a.mime_type, a.thumbnail_key
        FROM fonto.assets a
        WHERE a.lifecycle_state = 'active'
          AND (
            a.processing_state = 'captured'
            OR (a.processing_state = 'ready' AND a.thumbnail_key IS NULL)
          )
        ORDER BY a.created_at DESC
      `) as unknown as StuckRow[];

  console.log(`[reprocess-stuck] found ${rows.length} stuck asset(s)`);

  if (rows.length === 0 || dryRun) {
    if (dryRun) {
      for (const r of rows) {
        console.log(`[reprocess-stuck] would enqueue ${r.id} (${r.filename})`);
      }
    }
    await processQueue.close();
    await thumbQueue.close();
    redis.disconnect();
    await sql.end({ timeout: 5 });
    return;
  }

  // Look up workspace -> user_id so processAsset gets a valid identity.
  const workspaceIds = Array.from(new Set(rows.map((r) => r.workspace_id)));
  const wsRows = (await sql`
    SELECT id, user_id FROM fonto.workspaces WHERE id = ANY(${workspaceIds}::uuid[])
  `) as Array<{ id: string; user_id: string }>;
  const wsUser = new Map(wsRows.map((w) => [w.id, w.user_id]));

  // Per-invocation suffix so re-running after a Plexo 429 / rate-limit
  // wave actually re-enqueues. BullMQ dedupes by `jobId`, and a failed
  // job lingers in the queue's failed set — repeating the same jobId
  // silently no-ops. The runId makes each invocation unique.
  const runId = Date.now().toString(36);

  let enqueuedProcess = 0;
  let enqueuedThumb = 0;
  for (const r of rows) {
    const userId = wsUser.get(r.workspace_id);
    if (!userId) {
      console.warn(
        `[reprocess-stuck] skipping ${r.id}: workspace ${r.workspace_id} has no user_id`
      );
      continue;
    }
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
      { jobId: `reprocess-stuck-${runId}-${r.id}` }
    );
    enqueuedProcess++;

    if (!r.thumbnail_key) {
      await thumbQueue.add(
        "thumbnail",
        { assetId: r.id, workspaceId: r.workspace_id },
        { jobId: `reprocess-stuck-thumb-${runId}-${r.id}` }
      );
      enqueuedThumb++;
    }
  }

  console.log(
    `[reprocess-stuck] enqueued: process-asset=${enqueuedProcess} thumbnail=${enqueuedThumb}`
  );

  await processQueue.close();
  await thumbQueue.close();
  redis.disconnect();
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("[reprocess-stuck] fatal:", e);
  process.exit(1);
});
