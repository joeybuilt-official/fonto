// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.2 — backfill `assets.place_name` for rows that already have GPS
// coordinates but were uploaded before the geocoder shipped (or before the
// production deploy materialised the full cities500 dataset).
//
// Idempotent: each pass only touches rows with
//   latitude IS NOT NULL AND longitude IS NOT NULL AND place_name IS NULL.
// Re-running picks up new rows from later uploads + rows where the geocoder
// previously returned null because the placeholder dataset didn't cover that
// region — once `pnpm tsx scripts/fetch-geonames.ts` lands the full data,
// a follow-up backfill catches them.
//
// Usage:
//   pnpm backfill:places                  # full pass, batch=200
//   pnpm backfill:places -- --batch=50
//   pnpm backfill:places -- --dry-run
//
// Reads DATABASE_URL from env.

import postgres from "postgres";
import { nearestPlace, formatPlaceName } from "../lib/geocoder";

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
  latitude: number;
  longitude: number;
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
    skippedNoMatch: 0,
    failed: 0,
  };

  console.log(
    `[backfill-places] start (batch=${batchSize}${dryRun ? ", dry-run" : ""})`
  );

  try {
    // Cursor on id (UUID lex order) so re-runs keep advancing. The WHERE
    // clause stays place_name IS NULL throughout — successful updates drop
    // out of the candidate set on the next pass automatically.
    let lastId: string | null = null;

    for (;;) {
      const rows = (await sql`
        SELECT id, latitude, longitude
        FROM fonto.assets
        WHERE place_name IS NULL
          AND latitude  IS NOT NULL
          AND longitude IS NOT NULL
          ${lastId ? sql`AND id > ${lastId}` : sql``}
        ORDER BY id ASC
        LIMIT ${batchSize}
      `) as unknown as AssetRow[];

      if (rows.length === 0) break;

      for (const r of rows) {
        stats.scanned++;
        lastId = r.id;

        let placeName: string | null = null;
        try {
          const hit = await nearestPlace(r.latitude, r.longitude);
          if (hit) placeName = formatPlaceName(hit);
        } catch (err) {
          console.warn(`[backfill-places] geocode failed for ${r.id}:`, err);
          stats.failed++;
          continue;
        }

        if (placeName == null) {
          stats.skippedNoMatch++;
          continue;
        }

        if (dryRun) {
          console.log(
            `[backfill-places] ${r.id} (${r.latitude}, ${r.longitude}) -> "${placeName}"`
          );
          stats.updated++;
          continue;
        }

        await sql`
          UPDATE fonto.assets
          SET place_name = ${placeName},
              updated_at = now()
          WHERE id = ${r.id}
            AND place_name IS NULL
        `;
        stats.updated++;
      }
    }

    console.log(`[backfill-places] done`, stats);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[backfill-places] failed:", err);
  process.exit(1);
});
