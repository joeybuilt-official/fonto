// SPDX-License-Identifier: AGPL-3.0-only
// Called by an external scheduler (e.g. cron) to hard-purge trashed assets
// past the grace period. Protected by CRON_SECRET header.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import {
  assetStorageKey,
  assetStorageKeyLegacy,
  hlsSegmentKeyPrefix,
} from "@/lib/r2";
import { storage } from "@/lib/storage";
import { plexoPublishEvent } from "@/lib/plexo";

/**
 * Phase 8b — delete every R2 object under fonto/{ws}/{asset}/hls/.
 * Includes master + per-rendition playlists + .ts segments + sprite.
 * Safe to call when no HLS exists (ListObjectsV2 returns empty).
 */
async function purgeHlsObjects(workspaceId: string, assetId: string): Promise<number> {
  const prefix = hlsSegmentKeyPrefix(workspaceId, assetId);
  return storage().deletePrefix(prefix);
}

const GRACE_DAYS = 30;

export async function POST(request: NextRequest) {
  const secret = request.headers.get("X-Cron-Secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.lifecycleState, "trashed"),
        isNotNull(schema.assets.deletedAt),
        lt(schema.assets.deletedAt, cutoff)
      )
    );

  let purged = 0;
  let errors = 0;

  for (const asset of candidates) {
    try {
      const key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
      const legacyKey = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);

      try {
        await storage().delete(key);
      } catch {
        await storage().delete(legacyKey);
      }

      // Phase 8b — wipe any HLS ladder + sprite under fonto/{ws}/{id}/hls/.
      // Best-effort: a failure here doesn't block the purge; the keys
      // become R2 orphans that the next nightly sweep (when one
      // exists) can mop up.
      try {
        const n = await purgeHlsObjects(asset.workspaceId, asset.id);
        if (n > 0) console.log(`[fonto] purge-trashed: deleted ${n} HLS keys for ${asset.id}`);
      } catch (err) {
        console.warn(`[fonto] purge-trashed: HLS purge failed for ${asset.id}:`, err);
      }

      await db
        .update(schema.assets)
        .set({ lifecycleState: "purged", purgedAt: new Date() })
        .where(eq(schema.assets.id, asset.id));

      void plexoPublishEvent("ext.fonto.asset.purged", {
        assetId: asset.id,
        filename: asset.filename,
        reason: "grace-period-expired",
      });

      purged++;
    } catch (err) {
      console.error(`[fonto] purge-trashed: failed to purge ${asset.id}:`, err);
      errors++;
    }
  }

  return NextResponse.json({ purged, errors, candidates: candidates.length });
}
