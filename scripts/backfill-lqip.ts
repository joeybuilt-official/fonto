// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// T2.4 (fonto-perf-audit 2026-06-15) — backfill 4x4 WebP LQIP data URLs onto
// pre-T2.4 asset rows. Cheaper than re-running the full thumbnail pipeline:
// for each row we fetch the existing 256px thumb from R2 and run sharp on
// that (no decode of the original, no R2 PUT of new derivatives, no
// reprocessing of 256/1080).
//
// Resumable: the WHERE clause filters `lqip IS NULL AND thumbnail_key IS NOT
// NULL`, so re-running the script after an interruption picks up where it
// stopped without re-encoding rows that already have an LQIP. Within a single
// run, batches are walked via a keyset cursor on `id` so a slow batch can't
// trip a re-scan loop.
//
// Usage:
//   pnpm backfill:lqip                     # default batch=100
//   pnpm backfill:lqip -- --batch=50       # tune batch size
//   pnpm backfill:lqip -- --dry-run        # report, do not write
//   pnpm backfill:lqip -- --workspace=<id> # restrict to one workspace
//
// Reads DATABASE_URL + the standard R2_* envs (via the storage facade).

import postgres from "postgres";
import sharp from "sharp";
import { storage } from "@/lib/storage";

const LQIP_EDGE_PX = 4;
const LQIP_QUALITY = 25;

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
  thumbnail_key: string;
}

async function encodeLqip(thumbBytes: Buffer): Promise<string> {
  const buf = await sharp(thumbBytes, { failOn: "none" })
    .resize(LQIP_EDGE_PX, LQIP_EDGE_PX, { fit: "cover" })
    .webp({ quality: LQIP_QUALITY, effort: 3 })
    .toBuffer();
  return `data:image/webp;base64,${buf.toString("base64")}`;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!process.env.R2_BUCKET) throw new Error("R2_BUCKET not set");

  const batchSize = Math.max(parseInt(String(arg("batch") ?? "100"), 10), 1);
  const dryRun = !!arg("dry-run");
  const workspaceFilter = arg("workspace");
  const workspaceId =
    typeof workspaceFilter === "string" ? workspaceFilter : null;

  const sql = postgres(dbUrl, { prepare: false });
  const stats = {
    scanned: 0,
    encoded: 0,
    skippedNoThumb: 0,
    failed: 0,
    bytesTotal: 0,
  };
  console.log(
    `[backfill-lqip] start (batch=${batchSize}${dryRun ? ", dry-run" : ""}${
      workspaceId ? `, workspace=${workspaceId}` : ""
    })`
  );

  // Keyset cursor on `id` ASC. We re-select `lqip IS NULL` each batch so the
  // walk naturally skips rows we just wrote — that prevents the cursor from
  // ever landing on a row we'd re-encode. Stops when a batch returns 0.
  let cursorId: string | null = null;
  for (;;) {
    const rows = (cursorId
      ? workspaceId
        ? await sql<AssetRow[]>`
            SELECT id, thumbnail_key
            FROM fonto.assets
            WHERE lqip IS NULL
              AND thumbnail_key IS NOT NULL
              AND lifecycle_state = 'active'
              AND workspace_id = ${workspaceId}::uuid
              AND id > ${cursorId}::uuid
            ORDER BY id ASC
            LIMIT ${batchSize}
          `
        : await sql<AssetRow[]>`
            SELECT id, thumbnail_key
            FROM fonto.assets
            WHERE lqip IS NULL
              AND thumbnail_key IS NOT NULL
              AND lifecycle_state = 'active'
              AND id > ${cursorId}::uuid
            ORDER BY id ASC
            LIMIT ${batchSize}
          `
      : workspaceId
        ? await sql<AssetRow[]>`
            SELECT id, thumbnail_key
            FROM fonto.assets
            WHERE lqip IS NULL
              AND thumbnail_key IS NOT NULL
              AND lifecycle_state = 'active'
              AND workspace_id = ${workspaceId}::uuid
            ORDER BY id ASC
            LIMIT ${batchSize}
          `
        : await sql<AssetRow[]>`
            SELECT id, thumbnail_key
            FROM fonto.assets
            WHERE lqip IS NULL
              AND thumbnail_key IS NOT NULL
              AND lifecycle_state = 'active'
            ORDER BY id ASC
            LIMIT ${batchSize}
          `) as unknown as AssetRow[];

    if (rows.length === 0) break;
    stats.scanned += rows.length;

    for (const r of rows) {
      try {
        if (!r.thumbnail_key) {
          stats.skippedNoThumb++;
          continue;
        }
        const thumbBytes = await storage().getBuffer(r.thumbnail_key);
        const lqip = await encodeLqip(thumbBytes);
        stats.bytesTotal += lqip.length;
        if (!dryRun) {
          await sql`
            UPDATE fonto.assets
            SET lqip = ${lqip}
            WHERE id = ${r.id}::uuid
              AND lqip IS NULL
          `;
        }
        stats.encoded++;
      } catch (e) {
        stats.failed++;
        console.warn(`[backfill-lqip] fail id=${r.id}: ${(e as Error).message}`);
      }
    }

    cursorId = rows[rows.length - 1].id;
    const avg = stats.encoded > 0 ? Math.round(stats.bytesTotal / stats.encoded) : 0;
    console.log(
      `[backfill-lqip] scanned=${stats.scanned} encoded=${stats.encoded} failed=${stats.failed} avgBytes=${avg}`
    );

    if (rows.length < batchSize) break;
  }

  await sql.end({ timeout: 5 });
  console.log(`[backfill-lqip] complete: ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[backfill-lqip] fatal:", e);
  process.exit(1);
});
