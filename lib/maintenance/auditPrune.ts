// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.2 — audit_log retention reaper.
//
// Deletes audit_log rows older than `AUDIT_RETENTION_DAYS` (default 90).
// Scheduled by the BullMQ maintenance queue (see worker/index.ts). Once a
// day is plenty — the volume is low and the index on (created_at) keeps the
// delete cheap.
//
// Why a daily sweep instead of e.g. a Postgres pg_cron job? Keeping the
// retention policy in application code means it ships with the worker
// container and lives next to the privacy/data-retention contract in ADR
// 0007. Operators don't need DBA-level access to change the knob.

import { lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";

const reaperLogger = logger.child({ component: "audit.prune" });

/**
 * Number of days to keep audit rows. Configurable via AUDIT_RETENTION_DAYS
 * env. Default 90.
 */
export function getAuditRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (!raw) return 90;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 90;
  return n;
}

export interface AuditPruneResult {
  retentionDays: number;
  cutoff: string;
  deleted: number;
}

/**
 * Delete audit_log rows older than the configured retention window.
 *
 * Idempotent: running twice in a row deletes nothing the second time.
 * Returns the number of rows removed and the cutoff timestamp the sweep
 * computed (useful for logs + tests).
 */
export async function pruneAuditLog(): Promise<AuditPruneResult> {
  const retentionDays = getAuditRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  reaperLogger.info(
    { retentionDays, cutoff: cutoff.toISOString() },
    "audit prune tick start"
  );

  const result = await db
    .delete(schema.auditLog)
    .where(lt(schema.auditLog.createdAt, cutoff))
    .returning({ id: schema.auditLog.id });

  const deleted = result.length;
  reaperLogger.info(
    {
      retentionDays,
      cutoff: cutoff.toISOString(),
      deleted,
    },
    "audit prune tick complete"
  );

  // Light VACUUM hint — keeps the small table tight without acquiring the
  // heavy lock a VACUUM FULL would. Best-effort; ignore failure (test DBs
  // may not allow autovacuum control).
  try {
    await db.execute(sql`VACUUM (ANALYZE) fonto.audit_log`);
  } catch (err) {
    reaperLogger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "vacuum hint failed (ignored)"
    );
  }

  return { retentionDays, cutoff: cutoff.toISOString(), deleted };
}
