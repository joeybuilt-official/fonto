// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b — asset access resolver covering both ownership and
// cross-workspace shares (C5 reference model).
//
// Use this from any read-side asset route that needs to allow shared
// recipients alongside source-workspace members. Routes that perform
// destructive actions (DELETE, lifecycle PATCH) should NOT use this
// helper — they stay membership-only on the source workspace by design
// (source workspace retains control of their assets, per C5).

import { db, schema } from "@/lib/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getUserWorkspaces } from "@/lib/workspace";

export type AssetAccessVia = "membership" | "share";

export interface AssetAccess {
  ok: true;
  asset: typeof schema.assets.$inferSelect;
  via: AssetAccessVia;
  // For 'share': the share row's accessLevel (viewer..editor). For
  // 'membership': null — callers should re-fetch via `getUserWorkspaceRole`
  // if they need precise role authority on the source workspace.
  sharedAccessLevel: string | null;
}

/**
 * Resolve a user's access to an asset by id. Tries source-workspace
 * membership first, then falls back to active cross-workspace shares
 * granted to any workspace the caller belongs to.
 *
 * Returns `null` on no access (route should respond 404, not 403, to
 * avoid leaking asset existence to non-recipients).
 */
export async function resolveAssetAccess(
  userId: string,
  assetId: string
): Promise<AssetAccess | null> {
  const workspaces = await getUserWorkspaces(userId);
  if (!workspaces.length) return null;
  const workspaceIds = workspaces.map((w) => w.id);

  // 1. Direct ownership via membership on the asset's source workspace.
  const [owned] = await db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  if (owned) {
    return { ok: true, asset: owned, via: "membership", sharedAccessLevel: null };
  }

  // 2. Cross-workspace share: an active row targeting any of caller's
  // workspaces. Pull the source asset row directly (we don't care that
  // the caller has no membership on the source workspace).
  const [shared] = await db
    .select({
      asset: schema.assets,
      accessLevel: schema.sharedAssets.accessLevel,
    })
    .from(schema.sharedAssets)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.sharedAssets.assetId))
    .where(
      and(
        eq(schema.sharedAssets.assetId, assetId),
        inArray(schema.sharedAssets.targetWorkspaceId, workspaceIds),
        isNull(schema.sharedAssets.revokedAt)
      )
    )
    .limit(1);
  if (shared) {
    return {
      ok: true,
      asset: shared.asset,
      via: "share",
      sharedAccessLevel: shared.accessLevel,
    };
  }

  return null;
}
