// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// POST /api/admin/backfill-rotation
// Re-enqueue derivative generation for assets whose source has a non-trivial
// EXIF Orientation tag (2..8). Before Task #31, the worker's sharp pipelines
// did not call `.rotate()`, so existing thumb/preview derivatives for sideways
// or upside-down phone photos were baked rotated. With `.rotate()` wired into
// `generateThumbnails` / face crop loaders, re-running the same derivative
// job overwrites the same R2 keys with correctly-oriented bytes.
//
// Body: { workspaceId?, batch?, force? }
//   - workspaceId: scope to one workspace the caller owns; omit for all of them
//   - batch:       page size (default 100, max 500)
//   - force:       also include orientation IS NULL rows — for the case where
//                  the EXIF read at ingest missed the tag but sharp's reader
//                  would still detect+apply it from the raw bytes
//
// Behaviour: idempotent. Re-enqueues `generate-thumbnails` jobs with a stable
// `jobId` so BullMQ dedupes back-to-back runs while previous jobs are still
// in flight. The worker re-derives over the existing R2 keys. Mirrors the
// auth + body shape of `/api/admin/backfill-places`.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  lt,
  or,
  inArray,
  type SQL,
} from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { thumbnailQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "No workspaces" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    workspaceId?: unknown;
    batch?: unknown;
    force?: unknown;
  };

  const allWorkspaceIds = workspaces.map((w) => w.id);
  const targetWorkspaceIds =
    typeof body.workspaceId === "string" &&
    allWorkspaceIds.includes(body.workspaceId)
      ? [body.workspaceId]
      : allWorkspaceIds;

  const batch = Math.max(
    1,
    Math.min(500, Number(body.batch) > 0 ? Number(body.batch) : 100)
  );
  const force = body.force === true;

  // orientation > 1 means sharp's `.rotate()` will actually flip the pixels.
  // 1 / 0 / NULL are no-ops at the rotate step, so we skip them by default to
  // avoid churning a million derivatives that would re-encode to identical
  // bytes. `force=true` opts in to the NULL bucket for cases where the EXIF
  // read at ingest missed the tag (sharp can still detect it from the source
  // bytes at re-derive time).
  const orientationFilter: SQL = force
    ? (or(
        gt(schema.assets.orientation, 1),
        isNull(schema.assets.orientation)
      ) as SQL)
    : gt(schema.assets.orientation, 1);

  const stats = {
    scanned: 0,
    enqueued: 0,
    batches: 0,
  };
  const start = Date.now();

  // Keyset-paginate over assets.id descending so we drain deterministically
  // without re-selecting the same rows. The worker writes derivatives async,
  // so a "re-run as long as predicate matches" loop would re-enqueue every
  // page until the worker drains — see the cautionary tale in
  // scripts/backfill-thumbnails.ts.
  let cursorId: string | null = null;
  const MAX_PAGES = 1000;
  for (let page = 0; page < MAX_PAGES; page++) {
    const conds: SQL[] = [
      inArray(schema.assets.workspaceId, targetWorkspaceIds),
      eq(schema.assets.lifecycleState, "active"),
      orientationFilter,
    ];
    if (cursorId) conds.push(lt(schema.assets.id, cursorId));

    const rows = await db
      .select({
        id: schema.assets.id,
        workspaceId: schema.assets.workspaceId,
      })
      .from(schema.assets)
      .where(and(...conds))
      .orderBy(desc(schema.assets.id))
      .limit(batch);

    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    await thumbnailQueue().addBulk(
      rows.map((r) => ({
        name: JobNames.GenerateThumbnails,
        data: { assetId: r.id, workspaceId: r.workspaceId },
        // Stable jobId → BullMQ dedupes re-enqueues while the previous job
        // is still active. Safe to run this endpoint back-to-back.
        opts: { jobId: `backfill-rotation-${r.id}` },
      }))
    );
    stats.enqueued += rows.length;

    cursorId = rows[rows.length - 1].id;
    if (rows.length < batch) break;
  }

  return NextResponse.json({
    ...stats,
    durationMs: Date.now() - start,
  });
}

