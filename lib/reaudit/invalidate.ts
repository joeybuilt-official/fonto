// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 7. Reactive re-audit: when a dependency of a date
// inference changes (a temporal fact authored/edited/removed, a person's
// birth/death set), re-queue infer-date for exactly the affected assets —
// never a full library rescan.
//
// CONCURRENCY (3 replicas, no cluster-singleton queue): each re-queue uses a
// DETERMINISTIC jobId `reaudit:<asset>:<triggerHash>:<minuteBucket>`. Two
// replicas reacting to the same write within the same minute compute the same
// id, so BullMQ dedups the fan-out. A *later* genuine change produces a
// different triggerHash/bucket and is not suppressed. No advisory lock is
// needed on the infer path itself: inferAssetDate is a deterministic fuse + an
// atomic upsert whose setWhere only refreshes `inferred` rows, so a duplicate
// that slips through is a harmless re-computation that never clobbers a human
// decision.

import { createHash } from "node:crypto";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { inferDateQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";
import { logger } from "@/lib/logger";

export interface InvalidateArgs {
  workspaceId: string;
  /** Persons whose temporal anchors (birth/death) or membership changed. */
  personIds?: string[];
  /** Temporal facts authored / edited / removed. */
  factIds?: string[];
  /** Assets to re-audit directly (e.g. a neighbour confirm propagated). */
  assetIds?: string[];
}

/**
 * Find inference rows that depend on the changed entities and re-queue their
 * assets for re-fusion. Fire-and-forget at the call sites (never throws into a
 * write handler). Returns the number of assets re-queued.
 */
export async function invalidateByDependency(args: InvalidateArgs): Promise<{ requeued: number }> {
  const log = logger.child({ component: "reaudit.invalidate", workspaceId: args.workspaceId });
  const personIds = [...new Set((args.personIds ?? []).filter(Boolean))];
  const factIds = [...new Set((args.factIds ?? []).filter(Boolean))];
  const affected = new Set<string>((args.assetIds ?? []).filter(Boolean));

  if (personIds.length || factIds.length) {
    const conds: SQL[] = [];
    for (const id of personIds) {
      conds.push(sql`${schema.imageDateInference.dependsOn}->'personIds' @> ${JSON.stringify([id])}::jsonb`);
    }
    for (const id of factIds) {
      conds.push(sql`${schema.imageDateInference.dependsOn}->'factIds' @> ${JSON.stringify([id])}::jsonb`);
    }
    const rows = await db
      .select({ assetId: schema.imageDateInference.assetId })
      .from(schema.imageDateInference)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
      .where(and(eq(schema.assets.workspaceId, args.workspaceId), or(...conds)));
    for (const r of rows) affected.add(r.assetId);
  }

  if (affected.size === 0) return { requeued: 0 };

  const triggerHash = createHash("sha256")
    .update([...personIds, ...factIds].sort().join(","))
    .digest("hex")
    .slice(0, 12);
  const bucket = Math.floor(Date.now() / 60_000);

  const q = inferDateQueue();
  let requeued = 0;
  for (const assetId of affected) {
    try {
      await q.add(
        JobNames.InferDate,
        { assetId },
        { jobId: `reaudit-${assetId}-${triggerHash}-${bucket}` }
      );
      requeued++;
    } catch {
      // Duplicate jobId (a sibling replica already queued this exact wave) or a
      // transient redis hiccup — both safe to drop.
    }
  }
  log.info({ requeued, persons: personIds.length, facts: factIds.length }, "re-audit invalidation");
  return { requeued };
}
