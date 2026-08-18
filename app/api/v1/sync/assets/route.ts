// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2.3 — GET /api/v1/sync/assets?cursor=<seq>&limit=500
//
// Cursor-based delta sync for assets. Clients persist `nextCursor` from
// the previous response and pass it back; the server returns rows with
// `seq > cursor`, ordered by seq ASC, up to `limit` (default 500, max
// 1000). Each entry is either:
//   { op: 'upsert', seq, asset: { ... current row state ... } }
//   { op: 'delete', seq, id }   — when `deleted_at` or `purged_at` is set
//
// This is "compacted" sync: a client that has been offline for months
// receives the latest state, not every intermediate edit.
//
// TODO: register sync routes in 2.2 registry (lib/openapi/routes.ts)
// once Phase 2.2 lands its registry module.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, asc, gt, inArray, isNotNull } from "drizzle-orm";
import { parseCursor, parseLimit, encodeCursor, SyncCursorError } from "@/lib/sync/cursor";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import type { SyncDeleteEntry, SyncPage, SyncUpsertEntry } from "@/lib/sync/feed";

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    const empty: SyncPage<never> = { entries: [], nextCursor: "0", hasMore: false };
    return NextResponse.json(empty);
  }
  const workspaceIds = workspaces.map((w) => w.id);

  const { searchParams } = request.nextUrl;
  let cursor: bigint;
  let limit: number;
  try {
    cursor = parseCursor(searchParams.get("cursor")).value;
    limit = parseLimit(searchParams.get("limit"));
  } catch (err) {
    if (err instanceof SyncCursorError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Fetch one extra row to detect `hasMore` without a second query.
  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.workspaceId, workspaceIds),
        isNotNull(schema.assets.seq),
        gt(schema.assets.seq, cursor)
      )
    )
    .orderBy(asc(schema.assets.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const entries: Array<SyncDeleteEntry | SyncUpsertEntry<unknown>> = pageRows.map((row) => {
    const seqStr = row.seq != null ? row.seq.toString() : "0";
    const isTombstone = row.deletedAt != null || row.purgedAt != null;
    if (isTombstone) {
      return { op: "delete", id: row.id, seq: seqStr };
    }
    return {
      op: "upsert",
      seq: seqStr,
      asset: serializeAsset(row),
    };
  });

  const lastSeq = pageRows.length
    ? pageRows[pageRows.length - 1].seq?.toString() ?? encodeCursor(cursor)
    : encodeCursor(cursor);

  const page: SyncPage<unknown> = {
    entries,
    nextCursor: lastSeq,
    hasMore,
  };
  return NextResponse.json(page);
}
