// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M5d — worker-side sweeps backing the `/admin/reprocess` maintenance
// buttons. These are the SAME keyset predicates scripts/backfill-thumbnails.ts
// and scripts/backfill-clip-embeddings.ts use, reimplemented against the app's
// own Drizzle `db` + queue wrappers so the maintenance worker can run them
// without a separate process. Keep the predicates in step with the scripts:
//   - thumbnail: lifecycle active, renderable mime (image/%, video/%,
//     application/pdf), thumbnail_key IS NULL, thumbnail_state <> 'skipped'
//   - clip: lifecycle active, mime image/%, clip_vec IS NULL
//
// Both are single-pass keyset paginated over (created_at, id) and reclaim the
// retained TERMINAL job per id before re-adding (BullMQ refuses an add whose
// jobId exists in any set, including completed/failed — see scripts/ 2026-09-01
// fix). ACTIVE jobs are refused by `queue.remove` (returns 0), so nothing
// in flight is yanked. Idempotent + resumable: a re-run skips rows whose
// inline work already landed.

import { eq, and, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { enqueueThumbnail, enqueueClipEmbed } from "@/lib/queue/backfillEnqueue";

export interface BackfillResult {
  scanned: number;
  enqueued: number;
  reclaimed: number;
}

interface CursorRow {
  id: string;
  workspaceId: string;
  createdAt: Date;
}

const RENDERABLE_MIME_OF = or(
  sql`${schema.assets.mimeType} LIKE 'image/%'`,
  sql`${schema.assets.mimeType} LIKE 'video/%'`,
  eq(schema.assets.mimeType, "application/pdf")
);

/**
 * Re-enqueue `generate-thumbnails` for thumbnail-less renderable rows.
 * One pass (no re-select per batch) so rows whose worker just started do not
 * get re-enqueued every batch — the failure that ballooned the old loop.
 */
export async function backfillThumbnails(
  batchSize: number
): Promise<BackfillResult> {
  const stats: BackfillResult = { scanned: 0, enqueued: 0, reclaimed: 0 };
  let cursor: CursorRow | null = null;

  for (;;) {
    const conds = and(
      eq(schema.assets.lifecycleState, "active"),
      RENDERABLE_MIME_OF,
      isNull(schema.assets.thumbnailKey),
      ne(schema.assets.thumbnailState, "skipped"),
      cursor !== null
        ? sql`(${schema.assets.createdAt}, ${schema.assets.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : undefined
    ) as SQL | undefined;
    const rows = await db
      .select({
        id: schema.assets.id,
        workspaceId: schema.assets.workspaceId,
        createdAt: schema.assets.createdAt,
      })
      .from(schema.assets)
      .where(conds)
      .orderBy(sql`created_at DESC, id DESC`)
      .limit(batchSize);

    if (rows.length === 0) break;
    stats.scanned += rows.length;

    const reclaimed = await enqueueThumbnail(
      rows.map((r) => ({ assetId: r.id, workspaceId: r.workspaceId }))
    );
    stats.reclaimed += reclaimed;
    stats.enqueued += rows.length;

    const last = rows[rows.length - 1];
    cursor = { id: last.id, workspaceId: last.workspaceId, createdAt: last.createdAt };
    if (rows.length < batchSize) break;
  }

  return stats;
}

/**
 * Re-enqueue `embed-asset` for active image rows with no CLIP vector.
 * Same single-pass + reclaim discipline as backfillThumbnails.
 */
export async function backfillClip(batchSize: number): Promise<BackfillResult> {
  const stats: BackfillResult = { scanned: 0, enqueued: 0, reclaimed: 0 };
  let cursor: CursorRow | null = null;

  for (;;) {
    const conds = and(
      eq(schema.assets.lifecycleState, "active"),
      sql`${schema.assets.mimeType} LIKE 'image/%'`,
      isNull(schema.assets.clipVec),
      cursor !== null
        ? sql`(${schema.assets.createdAt}, ${schema.assets.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : undefined
    ) as SQL | undefined;
    const rows = await db
      .select({
        id: schema.assets.id,
        workspaceId: schema.assets.workspaceId,
        createdAt: schema.assets.createdAt,
      })
      .from(schema.assets)
      .where(conds)
      .orderBy(sql`created_at DESC, id DESC`)
      .limit(batchSize);

    if (rows.length === 0) break;
    stats.scanned += rows.length;

    const reclaimed = await enqueueClipEmbed(
      rows.map((r) => ({ assetId: r.id, workspaceId: r.workspaceId }))
    );
    stats.reclaimed += reclaimed;
    stats.enqueued += rows.length;

    const last = rows[rows.length - 1];
    cursor = { id: last.id, workspaceId: last.workspaceId, createdAt: last.createdAt };
    if (rows.length < batchSize) break;
  }

  return stats;
}