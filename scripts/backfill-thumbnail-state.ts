// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Consolidation Phase A / A1 — reconcile `thumbnail_state` against the thing
// that is actually true: whether `thumbnail_key` is populated.
//
// Context: docs/claude/platform/consolidation-2026-09/plan.md (Phase A, A1).
// `thumbnail_state` was added after the rows it describes and never
// backfilled: 227,328 rows carry a `thumbnail_key` (the thumbnail exists —
// generated, uploaded, in R2) while the state column still says `idle` or,
// for one row, a stale `failed`. Left alone this makes `thumbnail_state` a
// column of record even though it disagrees with reality, which is exactly
// what would break P2-M6 ("gate ML consumers on thumbnail_state='ready'") —
// that gate would wrongly exclude 98.5% of the library.
//
// Scope is deliberately narrow: this script only flips the state column. It
// does not touch `thumbnail_key`, `thumbnail_error`, or `thumbnail_generated_at`
// — those already describe what happened; only the summary state was stale.
//
// The other edge case the plan calls out — ~300 `idle` rows with NO
// `thumbnail_key` — is NOT touched here. Investigated live 2026-09-09: all
// 303 are `processing_state='ready'` non-thumbnailable mime types (mostly
// `application/octet-stream`, plus text/markup/binary types) that
// `generate-thumbnails` never attempts — see the mime allowlist comment in
// `scripts/backfill-thumbnails.ts`. `idle` with no key is correct for them;
// nothing is stuck.
//
// Idempotent and resumable: the predicate (`thumbnail_key IS NOT NULL AND
// thumbnail_state IN ('idle','failed')`) shrinks by exactly the rows each
// batch updates, so re-running after an interruption picks up where it left
// off and a full re-run against an already-reconciled table is a no-op.
// Batched with `FOR UPDATE SKIP LOCKED` so a row the pipeline is actively
// writing (e.g. mid-regeneration) is left for the next pass rather than
// blocking on it or racing it.
//
// Usage:
//   pnpm backfill:thumbnail-state --dry-run    # count only, no writes
//   pnpm backfill:thumbnail-state
//   pnpm backfill:thumbnail-state -- --batch=2000
//
// Reads DATABASE_URL via lib/db (same client the app uses, no second client).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  return flag.includes("=") ? flag.split("=")[1] : true;
}

async function main(): Promise<void> {
  const dryRun = !!arg("dry-run");
  const batchArg = arg("batch");
  const batchSize = Math.max(
    1,
    typeof batchArg === "string" ? Number.parseInt(batchArg, 10) : 5000
  );

  if (dryRun) {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM fonto.assets
      WHERE thumbnail_key IS NOT NULL AND thumbnail_state IN ('idle', 'failed')
    `)) as unknown as Array<{ n: number }>;
    console.log(`[backfill-thumbnail-state] dry-run: ${rows[0]?.n ?? 0} rows would be set to ready`);
    return;
  }

  let totalUpdated = 0;
  let batches = 0;
  for (;;) {
    const updated = (await db.execute(sql`
      WITH batch AS (
        SELECT id
        FROM fonto.assets
        WHERE thumbnail_key IS NOT NULL AND thumbnail_state IN ('idle', 'failed')
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE fonto.assets a
      SET thumbnail_state = 'ready', updated_at = now()
      FROM batch b
      WHERE a.id = b.id
      RETURNING a.id
    `)) as unknown as Array<{ id: string }>;

    if (updated.length === 0) break;
    batches++;
    totalUpdated += updated.length;
    console.log(
      `[backfill-thumbnail-state] batch ${batches} updated ${updated.length}; running total ${totalUpdated}`
    );
    if (updated.length < batchSize) break;
  }

  console.log(`[backfill-thumbnail-state] complete: ${totalUpdated} rows set to ready across ${batches} batches`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-thumbnail-state] fatal:", err);
    process.exit(1);
  });
