// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase B5 (storage placement) — nightly reconcile sweep for every active asset
// whose effective policy keeps a local copy, whether or not it CLAIMS one
// (local_original_stored_at may be NULL). It HEADs both backends and repairs
// divergence (pre-mortem #3 in ADR 0001):
//
//   • local gone, R2 present   → clear the stamp + re-enqueue mirror-sync so the
//                                 B3 worker re-copies R2→local (restore-local).
//   • R2 gone, local present   → re-push the local backup → R2 so the edge-cached
//                                 read path keeps working (reheal-r2). This is the
//                                 reconcile use of B4's readOriginalStream.
//   • both gone                → real data loss; log loudly, mutate nothing.
//
// Unstamped rows are in scope precisely because "missing from BOTH backends" is
// the failure that never stamps a local copy — filtering on the stamp made the
// only unrecoverable case invisible to the sweep.
//
// Throttled: bounded batch per tick (env-overridable). The decision logic is a
// pure table (`decideReconcileAction`) so it unit-tests without DB or R2.

import { Readable } from "node:stream";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";
import { readOriginalStream, isMissingObjectError } from "./read";

const LOCAL_POLICIES = ["mirror", "local_only"] as const;

/** Assets checked per reconcile tick. Override via env for live throttling. */
export const STORAGE_RECONCILE_BATCH_SIZE = (() => {
  const n = Number(process.env.STORAGE_RECONCILE_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
})();

export type ReconcileAction = "ok" | "restore-local" | "reheal-r2" | "lost";

/**
 * Pure divergence-decision table for a local-policy asset. What the bytes
 * actually are decides the action; the stamp only settles the both-present
 * case (a missing stamp there is itself the divergence to repair). Kept
 * side-effect-free so it's exhaustively unit-testable.
 */
export function decideReconcileAction(s: {
  stampSet: boolean;
  r2Present: boolean;
  localPresent: boolean;
}): ReconcileAction {
  if (!s.r2Present && !s.localPresent) return "lost";
  if (s.r2Present && !s.localPresent) return "restore-local";
  if (!s.r2Present && s.localPresent) return "reheal-r2";
  // Both present: stamped is healthy; unstamped means the DB lost the claim, so
  // re-run the sync and let the B3 worker re-stamp it.
  return s.stampSet ? "ok" : "restore-local";
}

async function backendHas(
  backend: { stat: (k: string) => Promise<unknown> },
  key: string
): Promise<boolean> {
  try {
    await backend.stat(key);
    return true;
  } catch (err) {
    if (isMissingObjectError(err) || (err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export interface ReconcileResult {
  checked: number;
  ok: number;
  restoredLocal: number;
  rehealedR2: number;
  lost: number;
}

/**
 * Reconcile up to `batchSize` local-policy assets, stamped or not. Each repair
 * is independent
 * and best-effort — a single asset's failure is logged and the sweep continues.
 */
export async function reconcileStorageMirror(
  batchSize = STORAGE_RECONCILE_BATCH_SIZE
): Promise<ReconcileResult> {
  const log = logger.child({ component: "storage-reconcile" });
  const result: ReconcileResult = { checked: 0, ok: 0, restoredLocal: 0, rehealedR2: 0, lost: 0 };

  if (!process.env.LOCAL_STORAGE_ROOT) {
    log.warn("LOCAL_STORAGE_ROOT unset — skipping reconcile");
    return result;
  }

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      localOriginalStoredAt: schema.assets.localOriginalStoredAt,
    })
    .from(schema.assets)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.assets.workspaceId))
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        or(
          inArray(schema.assets.storagePolicyOverride, [...LOCAL_POLICIES]),
          inArray(schema.workspaces.storagePolicy, [...LOCAL_POLICIES])
        )
      )
    )
    // Random sample, not the first N. Dropping the stamp filter widened the
    // candidate set to every active local-policy asset, and a healthy row stays
    // "ok" forever — so an unordered LIMIT would re-check the same arbitrary N
    // rows every night and never reach the rest. Sampling gives eventual
    // coverage of the whole corpus across runs without needing a cursor column.
    .orderBy(sql`random()`)
    .limit(batchSize);

  for (const row of rows) {
    result.checked++;
    const key = assetStorageKey(row.workspaceId, row.id, row.filename);
    try {
      const [r2Present, localPresent] = await Promise.all([
        backendHas(r2(), key),
        backendHas(localFs(), key),
      ]);
      const stampSet = row.localOriginalStoredAt !== null;
      const action = decideReconcileAction({ stampSet, r2Present, localPresent });

      if (action === "ok") {
        result.ok++;
      } else if (action === "restore-local") {
        // Local copy vanished (or was never stamped) — drop the (now-false) claim
        // and re-enqueue so the B3 worker re-copies from R2. Stamp must be cleared
        // first or the worker short-circuits on "already-synced"; an unstamped row
        // is already clear, so skip the pointless write.
        if (stampSet) {
          await db
            .update(schema.assets)
            .set({ localOriginalStoredAt: null })
            .where(eq(schema.assets.id, row.id));
        }
        await enqueueResync(row.id, row.workspaceId);
        result.restoredLocal++;
        log.warn(
          { assetId: row.id, stampSet, localPresent },
          "local original missing or unstamped — re-enqueued mirror-sync"
        );
      } else if (action === "reheal-r2") {
        // R2 lost the original; push the local backup back up. readOriginalStream
        // prefers R2 (race-safe: if R2 reappeared, it serves R2 and we skip).
        const res = await readOriginalStream({ key, hasLocalOriginal: true });
        if (res.source === "local") {
          // R2 PUT of a stream body needs ContentLength (no buffering — a video
          // original can be multi-GB). The local read reports the size; without
          // it the S3 client errors on a chunked-encoding content-length header.
          await r2().put(
            key,
            Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
            { contentType: row.mimeType, contentLength: res.contentLength }
          );
          result.rehealedR2++;
          log.warn({ assetId: row.id }, "R2 original missing — repushed from local backup");
        } else {
          // R2 recovered between stat and read; drain the stream, nothing to do.
          await res.body.cancel?.();
          result.ok++;
        }
      } else if (action === "lost") {
        // Unrecoverable: no byte source left to repair from. Tagged so it is
        // greppable in the log stream (`event=storage.original.lost`) — an
        // unstamped row reaching here is the case the old stamped-only query
        // could never see.
        result.lost++;
        log.error(
          {
            event: "storage.original.lost",
            assetId: row.id,
            workspaceId: row.workspaceId,
            filename: row.filename,
            key,
            stampSet,
          },
          "DATA LOSS: original missing from BOTH R2 and local for a local-policy asset"
        );
      }
    } catch (err) {
      log.warn({ assetId: row.id, err }, "reconcile failed for asset — continuing");
    }
  }

  log.info(result, "reconcile tick complete");
  return result;
}

async function enqueueResync(assetId: string, workspaceId: string): Promise<void> {
  const { storageSyncQueue, JobNames } = await import("@/lib/queue");
  await storageSyncQueue().add(JobNames.StorageSync, { assetId, workspaceId });
}
