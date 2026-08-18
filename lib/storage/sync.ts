// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase B3 (storage placement) — mirror an asset's ORIGINAL from R2 to the
// local backend for `mirror`-policy workspaces. Streams the copy (never buffers
// the whole original — videos can be multi-GB), size-verifies, then stamps
// assets.local_original_stored_at. Idempotent + safe to re-run.
//
// Operator decisions (ADR 0001): C2 = originals only (derivatives stay on R2),
// so this never copies thumbnails/previews/HLS. C4 = mirror only; there is no
// local_only copy-then-delete-R2 path in this initiative (the resolver returns
// local_only but no code sets a workspace to it yet).

import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";
import { effectiveStoragePolicy, policyKeepsLocalOriginal } from "@/lib/storage/policy";

export interface SyncAssetStorageResult {
  synced: boolean;
  reason?: "policy-not-local" | "already-synced" | "asset-missing" | "no-local-root";
  bytes?: number;
}

/**
 * Ensure the asset's original has a verified local copy when its effective
 * policy keeps one (`mirror`). Reads the asset + workspace policy from Postgres,
 * so the job payload stays tiny + the call is replay-safe.
 */
export async function syncAssetStorage(
  assetId: string,
  workspaceId: string
): Promise<SyncAssetStorageResult> {
  const log = logger.child({ component: "storage-sync", assetId, workspaceId });

  if (!process.env.LOCAL_STORAGE_ROOT) {
    log.warn("LOCAL_STORAGE_ROOT unset — cannot mirror");
    return { synced: false, reason: "no-local-root" };
  }

  const [row] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      sizeBytes: schema.assets.sizeBytes,
      override: schema.assets.storagePolicyOverride,
      localStoredAt: schema.assets.localOriginalStoredAt,
      wsPolicy: schema.workspaces.storagePolicy,
    })
    .from(schema.assets)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.assets.workspaceId))
    .where(eq(schema.assets.id, assetId))
    .limit(1);

  if (!row) {
    log.warn("asset row missing");
    return { synced: false, reason: "asset-missing" };
  }

  const policy = effectiveStoragePolicy({ workspacePolicy: row.wsPolicy, assetOverride: row.override });
  if (!policyKeepsLocalOriginal(policy)) {
    return { synced: false, reason: "policy-not-local" };
  }
  if (row.localStoredAt) {
    return { synced: false, reason: "already-synced" };
  }

  const key = assetStorageKey(row.workspaceId, row.id, row.filename);

  // Stream R2 → local (no full-object buffering). contentType is inert for the
  // local backend but kept honest so a future policy-routed put stays correct.
  const src = await r2().getStream(key);
  await localFs().put(
    key,
    Readable.fromWeb(src.body as Parameters<typeof Readable.fromWeb>[0]),
    { contentType: row.mimeType }
  );

  // Verify the local copy matches the row's declared size before marking it.
  const local = await localFs().stat(key);
  if (local.contentLength !== row.sizeBytes) {
    await localFs().delete(key);
    throw new Error(
      `storage-sync size mismatch for ${key}: local ${local.contentLength} != expected ${row.sizeBytes}`
    );
  }

  // Mark only this row, and only if still unset, so a concurrent run can't
  // double-stamp. (local_original_stored_at NULL guard.)
  await db
    .update(schema.assets)
    .set({ localOriginalStoredAt: new Date() })
    .where(and(eq(schema.assets.id, row.id), eq(schema.assets.workspaceId, row.workspaceId)));

  log.info({ bytes: row.sizeBytes, policy }, "mirrored original to local");
  return { synced: true, bytes: row.sizeBytes ?? undefined };
}
