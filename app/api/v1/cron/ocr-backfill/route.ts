// SPDX-License-Identifier: AGPL-3.0-only
// Nightly OCR backfill. Picks up `ocr_state='pending'` rows in batches and
// pushes them through Plexo's vision/ocr endpoint. Idempotent — failed rows
// are marked `failed` so a future run can manually retry by resetting them
// to `pending`.
//
// Trigger: external cron with `X-Cron-Secret: <CRON_SECRET>`.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { runOcrForAsset } from "@/app/api/v1/assets/route";
import { plexoEnsureWorkspace, plexoAvailable } from "@/lib/plexo";

const DEFAULT_BATCH_SIZE = 50;

export async function POST(request: NextRequest) {
  const secret = request.headers.get("X-Cron-Secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!plexoAvailable()) {
    return NextResponse.json({ skipped: true, reason: "plexo_unavailable" });
  }

  const url = new URL(request.url);
  const batch = Math.min(
    Math.max(parseInt(url.searchParams.get("batch") ?? `${DEFAULT_BATCH_SIZE}`, 10), 1),
    200
  );

  // Pick up pending image assets. Join workspaces to fish out the user_id
  // we need for plexoEnsureWorkspace.
  const rows = await db
    .select({
      assetId: schema.assets.id,
      fontoWorkspaceId: schema.assets.workspaceId,
      userId: schema.workspaces.userId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
    })
    .from(schema.assets)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.assets.workspaceId))
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.assets.ocrState, "pending"),
        isNotNull(schema.assets.workspaceId)
      )
    )
    .limit(batch);

  let ok = 0;
  let fail = 0;
  const wsCache = new Map<string, string>();

  for (const r of rows) {
    if (!r.mimeType.startsWith("image/")) {
      // Defensive: shouldn't happen because non-image rows are inserted with
      // ocr_state='skipped', but legacy rows may exist before this schema
      // change. Fix them up here.
      await db
        .update(schema.assets)
        .set({ ocrState: "skipped" })
        .where(eq(schema.assets.id, r.assetId));
      continue;
    }
    try {
      let plexoWs = wsCache.get(r.fontoWorkspaceId);
      if (!plexoWs) {
        plexoWs = await plexoEnsureWorkspace(r.userId, undefined);
        if (plexoWs) wsCache.set(r.fontoWorkspaceId, plexoWs);
      }
      if (!plexoWs) {
        fail++;
        continue;
      }
      await runOcrForAsset(r.assetId, plexoWs);
      // runOcrForAsset transitions ocr_state to 'ready' or 'failed' itself.
      const [refreshed] = await db
        .select({ s: schema.assets.ocrState })
        .from(schema.assets)
        .where(eq(schema.assets.id, r.assetId))
        .limit(1);
      if (refreshed?.s === "ready") ok++; else fail++;
    } catch (err) {
      console.error("[fonto] ocr-backfill: row failed", r.assetId, err);
      fail++;
    }
  }

  return NextResponse.json({ batch, processed: rows.length, ok, fail });
}
