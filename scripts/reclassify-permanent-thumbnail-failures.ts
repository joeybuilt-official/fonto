// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase C1 (2026-09-09) — one-time sweep of the existing `thumbnail_state=
// 'failed'` population against the (now generalized) permanent-failure
// classifier. `worker/index.ts` already applies `isPermanentThumbnailFailure`
// on every NEW terminal failure going forward (this is what the 2026-09-08
// EPS/BMP fix did for `unsupported mime type` alone); this script applies the
// same rule retroactively to the rows that failed before the classifier grew
// its other signatures, so today's failure count reflects reality instead of
// a stale write-time decision.
//
// Reclassifies ONLY: `thumbnail_state='failed' AND isPermanentThumbnailFailure
// (thumbnail_error)`. `thumbnail_error` is left untouched — it already records
// the real reason; only the STATE changes, from "might succeed on retry" to
// "will never succeed on retry, and that has been verified".
//
// This naturally excludes:
//   - the 18 D1 rows (`The specified key does not exist.` — a missing
//     ORIGINAL in R2, not a decode failure; matches no permanent signature),
//   - the video ffmpeg-seek/stream-map/strict-range rows (a real fix landed
//     in extractVideoThumbnail.ts in this same change — 'failed' stays
//     correct until the fix deploys and a retry proves it),
//   - the handful of pre-instrumentation rows with an empty thumbnail_error
//     (no evidence to classify from; left untouched, not guessed at).
//
// Idempotent / safe to re-run: the predicate is `thumbnail_state='failed'`,
// so a second run finds nothing left to reclassify.
//
// Usage:
//   pnpm tsx scripts/reclassify-permanent-thumbnail-failures.ts             # applies
//   pnpm tsx scripts/reclassify-permanent-thumbnail-failures.ts --dry-run   # print only
//
// Reads DATABASE_URL from env.

import postgres from "postgres";
import { isPermanentThumbnailFailure } from "@/lib/processing/permanentThumbnailFailure";

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface FailedRow {
  id: string;
  thumbnail_error: string | null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const dryRun = arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });

  const rows = (await sql`
    SELECT id, thumbnail_error
    FROM fonto.assets
    WHERE thumbnail_state = 'failed'
  `) as unknown as FailedRow[];

  const toSkip = rows.filter(
    (r) => r.thumbnail_error && isPermanentThumbnailFailure(r.thumbnail_error)
  );

  console.log(
    `[reclassify-permanent-thumbnail-failures] scanned ${rows.length} 'failed' rows; ` +
      `${toSkip.length} match a known-permanent signature${dryRun ? " (dry-run, no writes)" : ""}`
  );

  if (dryRun) {
    for (const r of toSkip) {
      console.log(`  would skip ${r.id}: ${(r.thumbnail_error ?? "").slice(0, 80)}`);
    }
    await sql.end({ timeout: 5 });
    return;
  }

  if (toSkip.length === 0) {
    await sql.end({ timeout: 5 });
    return;
  }

  const ids = toSkip.map((r) => r.id);
  const result = await sql`
    UPDATE fonto.assets
    SET thumbnail_state = 'skipped', updated_at = now()
    WHERE id = ANY(${ids})
      AND thumbnail_state = 'failed'
  `;

  console.log(`[reclassify-permanent-thumbnail-failures] updated ${result.count} rows`);
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("[reclassify-permanent-thumbnail-failures] fatal:", e);
  process.exit(1);
});
