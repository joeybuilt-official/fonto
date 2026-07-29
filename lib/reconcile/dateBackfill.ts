// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 8. Library-wide DATE backfill: take every
// high-confidence (gate=auto-commit) date inference the engine has proposed and
// commit it (status='confirmed' + assets.captured_at = mapEstimate) in
// idempotent, resumable batches.
//
// DRY-RUN FIRST: buildDateBackfillManifest is read-only — it bins every
// un-actioned proposal by gate decision and returns a SHA-256 over the
// actionable set. The apply step is operator-gated (enqueued with dryRun:false)
// and writes captured_at only on the auto-commit band.
//
// IDEMPOTENT + RESUMABLE: applyDateBackfill confirms in batches scoped to
// status='inferred'. A re-run (or a crashed-job resume) simply re-selects the
// remaining inferred rows — already-confirmed rows fall out of the predicate,
// so no double-write. The manifest hash lets a caller dedup the job by id.

import { createHash } from "node:crypto";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { DEFAULT_GATE_THRESHOLDS } from "@/lib/fusion/gate";
import { logger } from "@/lib/logger";

const DATE_HIGH = DEFAULT_GATE_THRESHOLDS.date.high; // auto-commit floor
const DATE_LOW = DEFAULT_GATE_THRESHOLDS.date.low; // review floor

export interface DateBackfillManifest {
  workspaceId: string;
  totalInferred: number;
  autoCommit: number;
  review: number;
  leave: number;
  conflicts: number;
  /** SHA-256 over the sorted auto-commit asset ids — a stable job/dedup key. */
  contentHash: string;
}

/** Read-only: bin every un-actioned proposal by the date gate. */
export async function buildDateBackfillManifest(workspaceId: string): Promise<DateBackfillManifest> {
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      autoCommit: sql<number>`count(*) filter (where not ${schema.imageDateInference.conflictFlag} and ${schema.imageDateInference.confidence} >= ${DATE_HIGH})::int`,
      review: sql<number>`count(*) filter (where ${schema.imageDateInference.conflictFlag} or (${schema.imageDateInference.confidence} >= ${DATE_LOW} and ${schema.imageDateInference.confidence} < ${DATE_HIGH}))::int`,
      leave: sql<number>`count(*) filter (where not ${schema.imageDateInference.conflictFlag} and ${schema.imageDateInference.confidence} < ${DATE_LOW})::int`,
      conflicts: sql<number>`count(*) filter (where ${schema.imageDateInference.conflictFlag})::int`,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.imageDateInference.status, "inferred")
      )
    );

  // Hash the actionable (auto-commit) id set so a caller can key a job to this
  // exact manifest. Cheap even at 20k — ids only, no payload.
  const autoIds = await db
    .select({ assetId: schema.imageDateInference.assetId })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.imageDateInference.status, "inferred"),
        eq(schema.imageDateInference.conflictFlag, false),
        gte(schema.imageDateInference.confidence, DATE_HIGH)
      )
    )
    .orderBy(asc(schema.imageDateInference.assetId));

  const contentHash = createHash("sha256")
    .update(autoIds.map((r) => r.assetId).join(","))
    .digest("hex");

  return {
    workspaceId,
    totalInferred: counts?.total ?? 0,
    autoCommit: counts?.autoCommit ?? 0,
    review: counts?.review ?? 0,
    leave: counts?.leave ?? 0,
    conflicts: counts?.conflicts ?? 0,
    contentHash,
  };
}

export interface ApplyOpts {
  dryRun?: boolean;
  batchSize?: number;
  /** Safety cap on total rows confirmed in one apply (0 = no cap). */
  maxRows?: number;
}

export interface ApplyResult {
  workspaceId: string;
  dryRun: boolean;
  candidates: number;
  confirmed: number;
}

/**
 * Confirm the auto-commit date band in batches. dryRun returns the candidate
 * count without writing. The write is transactional per batch and scoped to
 * status='inferred', so it is safe to re-run / resume.
 */
export async function applyDateBackfill(workspaceId: string, opts: ApplyOpts = {}): Promise<ApplyResult> {
  const dryRun = opts.dryRun ?? true;
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize ?? 200));
  const maxRows = opts.maxRows ?? 0;
  const log = logger.child({ component: "reconcile.dateBackfill", workspaceId, dryRun });

  const autoCommitWhere = and(
    eq(schema.assets.workspaceId, workspaceId),
    eq(schema.assets.lifecycleState, "active"),
    eq(schema.imageDateInference.status, "inferred"),
    eq(schema.imageDateInference.conflictFlag, false),
    gte(schema.imageDateInference.confidence, DATE_HIGH)
  );

  const [{ candidates }] = await db
    .select({ candidates: sql<number>`count(*)::int` })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(autoCommitWhere);

  if (dryRun) {
    return { workspaceId, dryRun: true, candidates: candidates ?? 0, confirmed: 0 };
  }

  let confirmed = 0;
  // Loop batches: each pass selects up-to-batchSize still-inferred auto-commit
  // rows (with their MAP date) and confirms them in one transaction. The
  // predicate naturally advances as rows flip to 'confirmed'.
  for (;;) {
    if (maxRows && confirmed >= maxRows) break;
    const take = maxRows ? Math.min(batchSize, maxRows - confirmed) : batchSize;
    const batch = await db
      .select({
        assetId: schema.imageDateInference.assetId,
        mapEstimate: schema.imageDateInference.mapEstimate,
      })
      .from(schema.imageDateInference)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
      .where(autoCommitWhere)
      .limit(take);
    if (batch.length === 0) break;

    await db.transaction(async (tx) => {
      for (const row of batch) {
        const upd = await tx
          .update(schema.imageDateInference)
          .set({ status: "confirmed" })
          .where(
            and(
              eq(schema.imageDateInference.assetId, row.assetId),
              eq(schema.imageDateInference.status, "inferred")
            )
          )
          .returning({ assetId: schema.imageDateInference.assetId });
        // Only write captured_at if WE flipped the row (guards a racing apply).
        if (upd.length > 0 && row.mapEstimate) {
          await tx
            .update(schema.assets)
            .set({ capturedAt: new Date(row.mapEstimate) })
            .where(and(eq(schema.assets.id, row.assetId), eq(schema.assets.workspaceId, workspaceId)));
          confirmed++;
        }
      }
    });
    if (batch.length < take) break;
  }

  log.info({ candidates, confirmed }, "date backfill applied");
  return { workspaceId, dryRun: false, candidates: candidates ?? 0, confirmed };
}
