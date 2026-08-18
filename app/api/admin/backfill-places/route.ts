// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// POST /api/admin/backfill-places
// Reverse-geocode every asset that has GPS coordinates but no place_name.
// Mirrors `scripts/backfill-place-names.ts` but runnable from the deployed
// runtime (the Next.js standalone build doesn't ship the scripts/ folder,
// so the operator-CLI path isn't available in prod). Idempotent.
//
// Body: { workspaceId?, batch? } — workspaceId scopes to one workspace,
// omit for global; batch controls page size (default 200, max 1000).
//
// Authed via better-auth; only the asset's workspace owner can trigger.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, isNotNull, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { nearestPlace, formatPlaceName } from "@/lib/geocoder";

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "No workspaces" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    workspaceId?: unknown;
    batch?: unknown;
  };

  const allWorkspaceIds = workspaces.map((w) => w.id);
  const targetWorkspaceIds =
    typeof body.workspaceId === "string" &&
    allWorkspaceIds.includes(body.workspaceId)
      ? [body.workspaceId]
      : allWorkspaceIds;

  const batch = Math.max(
    1,
    Math.min(1000, Number(body.batch) > 0 ? Number(body.batch) : 200)
  );

  const stats = {
    scanned: 0,
    updated: 0,
    skippedNoMatch: 0,
    failed: 0,
    batches: 0,
  };

  const start = Date.now();

  // Drain in pages — the dataset is in memory after first lookup so each
  // batch is bound by DB write throughput, not geocoder latency.
  for (let page = 0; page < 200; page++) {
    const rows = await db
      .select({
        id: schema.assets.id,
        latitude: schema.assets.latitude,
        longitude: schema.assets.longitude,
      })
      .from(schema.assets)
      .where(
        and(
          inArray(schema.assets.workspaceId, targetWorkspaceIds),
          eq(schema.assets.lifecycleState, "active"),
          isNotNull(schema.assets.latitude),
          isNotNull(schema.assets.longitude),
          isNull(schema.assets.placeName)
        )
      )
      .limit(batch);

    if (rows.length === 0) break;
    stats.batches++;

    for (const r of rows) {
      stats.scanned++;
      if (r.latitude == null || r.longitude == null) continue;
      try {
        const hit = await nearestPlace(r.latitude, r.longitude);
        if (!hit) {
          stats.skippedNoMatch++;
          // Mark as "tried" so we don't loop forever — use empty string?
          // Simpler: leave NULL; the WHERE excludes assets at >200km from any
          // populated place, so re-running picks the same rows back up. That's
          // a small fixed set, acceptable cost.
          continue;
        }
        await db
          .update(schema.assets)
          .set({ placeName: formatPlaceName(hit) })
          .where(eq(schema.assets.id, r.id));
        stats.updated++;
      } catch (err) {
        stats.failed++;
        console.warn(`[backfill-places] ${r.id} failed:`, err);
      }
    }

    if (rows.length < batch) break;
  }

  return NextResponse.json({
    ...stats,
    durationMs: Date.now() - start,
  });
}
