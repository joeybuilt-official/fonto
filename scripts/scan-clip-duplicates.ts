// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.5 — bulk CLIP-similarity duplicate scan.
//
// Iterates every asset that has a `clip_vec` but no `clip_dedup_checked_at`
// stamp, runs `nearestNeighbors()` against the same workspace's other
// assets, and emits a JSONL report to stdout:
//
//   { "assetId": "<uuid>", "matches": [ { "otherAssetId": "<uuid>", "similarity": 0.94 } ] }
//
// Operators decide what to do with the results (notify users, soft-delete,
// surface in admin tools, etc.). This script DOES NOT mutate the assets
// table itself unless `--mark-checked` is passed, in which case it stamps
// `clip_dedup_checked_at` so subsequent runs skip the row.
//
// Usage:
//   pnpm scan:clip-duplicates
//   pnpm scan:clip-duplicates -- --batch=50 --threshold=0.94
//   pnpm scan:clip-duplicates -- --workspace=<uuid>
//   pnpm scan:clip-duplicates -- --mark-checked
//   pnpm scan:clip-duplicates -- --limit=1000
//
// Stub-aware: until Phase 4.3 ships `nearestNeighbors()` for real, the
// scan emits empty `matches` arrays. Until 4.2 ships `clip_vec`, the query
// returns no rows and the script exits cleanly.
//
// Reads DATABASE_URL from env.

import postgres from "postgres";
import { nearestNeighbors } from "../lib/vectors";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  // postgres-js returns pgvector as its text literal (`"[0.1,0.2,...]"`) —
  // drizzle's customType parses it for app queries, but this script talks to
  // postgres-js directly and has to parse the column itself.
  clip_vec: string | null;
}

function parseVector(raw: string): number[] {
  return JSON.parse(raw) as number[];
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const batchSize = Math.max(parseInt(String(arg("batch") ?? "100"), 10), 1);
  const limit = arg("limit") ? Math.max(parseInt(String(arg("limit")), 10), 1) : Infinity;
  const thresholdArg = arg("threshold");
  const threshold = thresholdArg ? Number(thresholdArg) : Number(process.env.CLIP_DEDUP_THRESHOLD ?? 0.92);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`invalid --threshold: ${thresholdArg}`);
  }
  const workspaceFilter = typeof arg("workspace") === "string" ? (arg("workspace") as string) : null;
  const markChecked = !!arg("mark-checked");

  const sql = postgres(dbUrl);

  let processed = 0;
  let cursor: { createdAt: string; id: string } | null = null;

  try {
    // We page by (created_at, id) ascending so the index on the partial
    // `assets_clip_dedup_pending_idx` carries the scan. If --workspace is
    // set we filter to a single workspace.
    for (;;) {
      if (processed >= limit) break;
      const remaining = Math.min(batchSize, limit - processed);

      // Defensive: SELECT may fail if the `clip_vec` column doesn't exist
      // yet (Phase 4.3 hasn't shipped). Catch and exit cleanly.
      let rows: CandidateRow[] = [];
      try {
        if (workspaceFilter) {
          rows = await sql<CandidateRow[]>`
            SELECT id, workspace_id, clip_vec
              FROM fonto.assets
             WHERE clip_vec IS NOT NULL
               AND clip_dedup_checked_at IS NULL
               AND lifecycle_state = 'active'
               AND workspace_id = ${workspaceFilter}
               ${cursor ? sql`AND (created_at, id) > (${cursor.createdAt}, ${cursor.id})` : sql``}
             ORDER BY created_at ASC, id ASC
             LIMIT ${remaining}
          `;
        } else {
          rows = await sql<CandidateRow[]>`
            SELECT id, workspace_id, clip_vec
              FROM fonto.assets
             WHERE clip_vec IS NOT NULL
               AND clip_dedup_checked_at IS NULL
               AND lifecycle_state = 'active'
               ${cursor ? sql`AND (created_at, id) > (${cursor.createdAt}, ${cursor.id})` : sql``}
             ORDER BY created_at ASC, id ASC
             LIMIT ${remaining}
          `;
        }
      } catch (err) {
        process.stderr.write(
          `[scan-clip-duplicates] query failed (clip_vec column may not exist yet): ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
        break;
      }

      if (rows.length === 0) break;

      for (const row of rows) {
        if (!row.clip_vec || row.clip_vec.length === 0) continue;
        const queryVec = parseVector(row.clip_vec);
        if (queryVec.length === 0) continue;
        let matches: Awaited<ReturnType<typeof nearestNeighbors>> = [];
        try {
          matches = (await nearestNeighbors(row.workspace_id, queryVec, 5, threshold)).filter(
            (m) => m.assetId !== row.id
          );
        } catch (err) {
          process.stderr.write(
            `[scan-clip-duplicates] nearestNeighbors failed for ${row.id}: ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
        const report = {
          assetId: row.id,
          matches: matches.map((m) => ({
            otherAssetId: m.assetId,
            similarity: m.similarity,
          })),
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
      }

      if (markChecked) {
        const ids = rows.map((r) => r.id);
        await sql`
          UPDATE fonto.assets
             SET clip_dedup_checked_at = now()
           WHERE id = ANY(${ids}::uuid[])
        `;
      }

      processed += rows.length;
      // Advance cursor using the last row of this batch. Fetch its
      // created_at since we didn't select it above.
      const lastId = rows[rows.length - 1].id;
      const [tail] = await sql<{ created_at: string }[]>`
        SELECT created_at FROM fonto.assets WHERE id = ${lastId} LIMIT 1
      `;
      if (!tail) break;
      cursor = { createdAt: tail.created_at, id: lastId };

      if (rows.length < remaining) break;
    }

    process.stderr.write(`[scan-clip-duplicates] processed ${processed} asset(s)\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  process.stderr.write(
    `[scan-clip-duplicates] fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
