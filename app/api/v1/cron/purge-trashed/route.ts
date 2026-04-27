// SPDX-License-Identifier: AGPL-3.0-only
// Called by an external scheduler (e.g. cron) to hard-purge trashed assets
// past the grace period. Protected by CRON_SECRET header.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { db, schema } from "@/lib/db";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import { getS3Client, assetStorageKey, assetStorageKeyLegacy } from "@/lib/r2";
import { plexoPublishEvent } from "@/lib/plexo";

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
  const bucket = process.env.R2_BUCKET!;

  for (const asset of candidates) {
    try {
      const key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
      const legacyKey = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);

      try {
        await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: legacyKey }));
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
