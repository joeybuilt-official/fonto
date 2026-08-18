// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2.3 — GET /api/v1/sync/tags?cursor=<seq>&limit=500
//
// Cursor-based delta sync for tags. Same shape as /sync/assets. Tags
// have no lifecycle column, so every row is emitted as an upsert (hard
// deletes will manifest as absence on a full client refresh).
//
// TODO: register sync routes in 2.2 registry (lib/openapi/routes.ts)
// once Phase 2.2 lands its registry module.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, asc, gt, inArray, isNotNull } from "drizzle-orm";
import { parseCursor, parseLimit, encodeCursor, SyncCursorError } from "@/lib/sync/cursor";
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

  const rows = await db
    .select()
    .from(schema.tags)
    .where(
      and(
        inArray(schema.tags.workspaceId, workspaceIds),
        isNotNull(schema.tags.seq),
        gt(schema.tags.seq, cursor)
      )
    )
    .orderBy(asc(schema.tags.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const entries: Array<SyncDeleteEntry | SyncUpsertEntry<unknown>> = pageRows.map((row) => ({
    op: "upsert",
    seq: row.seq != null ? row.seq.toString() : "0",
    tag: row,
  }));

  const lastSeq = pageRows.length
    ? pageRows[pageRows.length - 1].seq?.toString() ?? encodeCursor(cursor)
    : encodeCursor(cursor);

  const page: SyncPage<unknown> = { entries, nextCursor: lastSeq, hasMore };
  return NextResponse.json(page);
}
