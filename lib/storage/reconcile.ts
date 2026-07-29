// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase B5 (storage placement) — nightly reconcile sweep for `mirror`-policy
// assets that CLAIM a local copy (local_original_stored_at IS NOT NULL). It
// HEADs both backends and repairs divergence (pre-mortem #3 in ADR 0001):
//
//   • local gone, R2 present   → clear the stamp + re-enqueue mirror-sync so the
//                                 B3 worker re-copies R2→local (restore-local).
//   • R2 gone, local present   → re-push the local backup → R2 so the edge-cached
//                                 read path keeps working (reheal-r2). This is the
//                                 reconcile use of B4's readOriginalStream.
//   • both gone                → real data loss; log loudly, mutate nothing.
//
// Throttled: bounded batch per tick (env-overridable). The decision logic is a
// pure table (`decideReconcileAction`) so it unit-tests without DB or R2.

import { Readable } from "node:stream";
import { and, eq, isNotNull, inArray, or } from "drizzle-orm";
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

export type ReconcileAction =
  | "ok"
  | "restore-local"
  | "reheal-r2"
  | "lost"
  | "not-stamped";

/**
 * Pure divergence-decision table for a stamped (claims-local) mirror asset.
 * Kept side-effect-free so it's exhaustively unit-testable.
 */
export function decideReconcileAction(s: {
  stampSet: boolean;
  r2Present: boolean;
  localPresent: boolean;
}): ReconcileAction {
  if (!s.stampSet) return "not-stamped";
  if (s.r2Present && s.localPresent) return "ok";
  if (s.r2Present && !s.localPresent) return "restore-local";
  if (!s.r2Present && s.localPresent) return "reheal-r2";
  return "lost";
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
 * Reconcile up to `batchSize` stamped mirror assets. Each repair is independent
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
    })
    .from(schema.assets)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.assets.workspaceId))
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        isNotNull(schema.assets.localOriginalStoredAt),
        or(
          inArray(schema.assets.storagePolicyOverride, [...LOCAL_POLICIES]),
          inArray(schema.workspaces.storagePolicy, [...LOCAL_POLICIES])
        )
      )
    )
    .limit(batchSize);

  for (const row of rows) {
    result.checked++;
    const key = assetStorageKey(row.workspaceId, row.id, row.filename);
    try {
      const [r2Present, localPresent] = await Promise.all([
        backendHas(r2(), key),
        backendHas(localFs(), key),
      ]);
      const action = decideReconcileAction({ stampSet: true, r2Present, localPresent });

      if (action === "ok") {
        result.ok++;
      } else if (action === "restore-local") {
        // Local copy vanished — drop the (now-false) claim and re-enqueue so the
        // B3 worker re-copies from R2. Stamp must be cleared first or the worker
        // short-circuits on "already-synced".
        await db
          .update(schema.assets)
          .set({ localOriginalStoredAt: null })
          .where(eq(schema.assets.id, row.id));
        await enqueueResync(row.id, row.workspaceId);
        result.restoredLocal++;
        log.warn({ assetId: row.id }, "local original missing — re-enqueued mirror-sync");
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
        result.lost++;
        log.error(
          { assetId: row.id, key },
          "DATA LOSS: original missing from BOTH R2 and local for a mirrored asset"
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
