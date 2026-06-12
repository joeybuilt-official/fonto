// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase B5 (storage placement) — throttled, resumable backfill of existing
// originals for `mirror`/`local_only` workspaces. Each tick selects a bounded
// batch of eligible assets that DON'T yet have a verified local copy
// (local_original_stored_at IS NULL) and enqueues a storage-sync job per asset;
// the existing B3 mirror worker does the actual R2→local copy + verify + stamp.
//
// Resumable: every tick re-selects un-stamped eligible rows, so as the mirror
// worker stamps assets they drop out of the candidate set — no cursor needed.
// Throttled: bounded batch per tick × the storage-sync queue's concurrency.
// C2: originals only (the worker never copies derivatives).

import { and, eq, isNull, inArray, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { storageSyncQueue, JobNames } from "@/lib/queue";

const LOCAL_POLICIES = ["mirror", "local_only"] as const;

/** Assets enqueued per backfill tick. Override via env for live throttling. */
export const STORAGE_BACKFILL_BATCH_SIZE = (() => {
  const n = Number(process.env.STORAGE_BACKFILL_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

export interface BackfillResult {
  candidates: number;
  enqueued: number;
}

/**
 * Enqueue mirror-sync for up to `batchSize` eligible un-mirrored originals.
 * Effective-policy-keeps-local is filtered in SQL: an override pins the asset,
 * else the workspace default decides. No-ops cleanly when LOCAL_STORAGE_ROOT is
 * unset (no mount → nothing to mirror into).
 */
export async function backfillStorageMirror(
  batchSize = STORAGE_BACKFILL_BATCH_SIZE
): Promise<BackfillResult> {
  const log = logger.child({ component: "storage-backfill" });
  if (!process.env.LOCAL_STORAGE_ROOT) {
    log.warn("LOCAL_STORAGE_ROOT unset — skipping backfill");
    return { candidates: 0, enqueued: 0 };
  }

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
    })
    .from(schema.assets)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.assets.workspaceId))
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        isNull(schema.assets.localOriginalStoredAt),
        // effective policy keeps a local original: override pins it, else ws default
        or(
          inArray(schema.assets.storagePolicyOverride, [...LOCAL_POLICIES]),
          and(
            isNull(schema.assets.storagePolicyOverride),
            inArray(schema.workspaces.storagePolicy, [...LOCAL_POLICIES])
          )
        )
      )
    )
    .limit(batchSize);

  let enqueued = 0;
  for (const r of rows) {
    try {
      await storageSyncQueue().add(JobNames.StorageSync, {
        assetId: r.id,
        workspaceId: r.workspaceId,
      });
      enqueued++;
    } catch (err) {
      log.warn({ assetId: r.id, err }, "backfill enqueue failed");
    }
  }

  log.info({ candidates: rows.length, enqueued }, "backfill tick complete");
  return { candidates: rows.length, enqueued };
}
