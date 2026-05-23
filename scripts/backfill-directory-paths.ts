// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.5 — backfill `directory_path` from legacy filename rows.
//
// Some pre-3.5 uploads (CLI tools, drag-and-drop folder bulk-uploads) crammed
// a relative path into the `filename` column itself, e.g.
//   filename = "Photos/2024/Iceland/IMG_0001.jpg"
//
// When the folder column shipped, those rows still have NULL `directory_path`
// but their filename carries the directory tree we'd like to surface. This
// script splits them:
//   directory_path = "/Photos/2024/Iceland"
//   filename       = "IMG_0001.jpg"
//
// Idempotent: skips rows where directory_path IS NOT NULL (already split).
// Also skips rows whose filename contains no `/` (nothing to split) and
// rows where the normaliser rejects the directory portion (invalid shape).
//
// Usage:
//   pnpm backfill:folders                # full pass, batch=200
//   pnpm backfill:folders -- --batch=50
//   pnpm backfill:folders -- --dry-run
//
// Reads DATABASE_URL from env.

import postgres from "postgres";
import { normalizeDirectoryPath } from "../lib/folders/normalize";

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
  filename: string;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const batchSize = parseInt(String(arg("batch") ?? "200"), 10);
  const dryRun = !!arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });

  const stats = {
    scanned: 0,
    updated: 0,
    skippedNoSlash: 0,
    skippedInvalid: 0,
  };

  console.log(
    `[backfill-folders] start (batch=${batchSize}${dryRun ? ", dry-run" : ""})`
  );

  try {
    // Cursor on `id` (UUIDs are unordered but lex order is stable) to keep
    // re-runs picking up new rows; we filter NULL directory_path each pass
    // so the working set shrinks monotonically.
    let lastId: string | null = null;

    for (;;) {
      const rows = (await sql`
        SELECT id, filename
        FROM fonto.assets
        WHERE directory_path IS NULL
          AND filename LIKE '%/%'
          ${lastId ? sql`AND id > ${lastId}` : sql``}
        ORDER BY id ASC
        LIMIT ${batchSize}
      `) as unknown as AssetRow[];

      if (rows.length === 0) break;

      for (const r of rows) {
        stats.scanned++;
        lastId = r.id;

        const idx = r.filename.lastIndexOf("/");
        if (idx <= 0) {
          stats.skippedNoSlash++;
          continue;
        }
        const dirPortion = r.filename.slice(0, idx);
        const basename = r.filename.slice(idx + 1);
        if (basename.length === 0) {
          stats.skippedNoSlash++;
          continue;
        }
        const normalized = normalizeDirectoryPath(dirPortion);
        if (!normalized) {
          stats.skippedInvalid++;
          continue;
        }

        if (dryRun) {
          console.log(
            `[backfill-folders] ${r.id} "${r.filename}" -> dir="${normalized}" filename="${basename}"`
          );
          stats.updated++;
          continue;
        }

        await sql`
          UPDATE fonto.assets
          SET directory_path = ${normalized},
              filename       = ${basename},
              updated_at     = now()
          WHERE id = ${r.id}
            AND directory_path IS NULL
        `;
        stats.updated++;
      }
    }

    console.log(`[backfill-folders] done`, stats);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[backfill-folders] failed:", err);
  process.exit(1);
});
