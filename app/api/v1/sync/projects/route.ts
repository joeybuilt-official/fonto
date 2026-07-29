// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/sync/projects?cursor=<seq>&limit=500
//
// Cursor-based delta sync for projects. Same shape as /sync/assets and
// /sync/collections. Projects carry a `deleted_at` tombstone column, so a
// soft-deleted project is emitted as a `delete` entry (mirrors assets).
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
    .from(schema.projects)
    .where(
      and(
        inArray(schema.projects.workspaceId, workspaceIds),
        isNotNull(schema.projects.seq),
        gt(schema.projects.seq, cursor)
      )
    )
    .orderBy(asc(schema.projects.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const entries: Array<SyncDeleteEntry | SyncUpsertEntry<unknown>> = pageRows.map((row) => {
    const seqStr = row.seq != null ? row.seq.toString() : "0";
    const isTombstone = row.deletedAt != null;
    if (isTombstone) {
      return { op: "delete", id: row.id, seq: seqStr };
    }
    return { op: "upsert", seq: seqStr, project: row };
  });

  const lastSeq = pageRows.length
    ? pageRows[pageRows.length - 1].seq?.toString() ?? encodeCursor(cursor)
    : encodeCursor(cursor);

  const page: SyncPage<unknown> = { entries, nextCursor: lastSeq, hasMore };
  return NextResponse.json(page);
}
