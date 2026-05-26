// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — workspace activity feed.
//
//   GET /api/v1/workspace/activity[?createdBefore=<iso>&limit=N]
//     Newest-first list of activity_events for the caller's workspace.
//     Cursor pagination via createdBefore (same idiom as /api/v1/assets).
//     Default limit 50, max 200.
//
// Authz: viewer or higher on the workspace. The feed is visible to every
// member because it's how they learn that something happened.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, desc, eq, lt } from "drizzle-orm";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ events: [], nextCursor: null });
  // Same convention as other workspace-scoped routes: act on the first
  // workspace. Multi-workspace surface lives behind the workspace
  // switcher; the API call passes through whichever is active.
  const workspaceId = workspaces[0].id;

  const { searchParams } = request.nextUrl;
  const createdBeforeRaw = searchParams.get("createdBefore");
  const createdBefore =
    createdBeforeRaw && !Number.isNaN(Date.parse(createdBeforeRaw))
      ? new Date(createdBeforeRaw)
      : null;

  const limitRaw = searchParams.get("limit");
  const limitParsed = limitRaw == null ? NaN : Number.parseInt(limitRaw, 10);
  const limit =
    Number.isInteger(limitParsed) && limitParsed > 0 && limitParsed <= MAX_LIMIT
      ? limitParsed
      : DEFAULT_LIMIT;

  const conditions = [eq(schema.activityEvents.workspaceId, workspaceId)];
  if (createdBefore) {
    conditions.push(lt(schema.activityEvents.createdAt, createdBefore));
  }

  const rows = await db
    .select()
    .from(schema.activityEvents)
    .where(and(...conditions))
    .orderBy(desc(schema.activityEvents.createdAt), desc(schema.activityEvents.id))
    .limit(limit);

  const lastRow = rows[rows.length - 1];
  const nextCursor =
    lastRow && rows.length === limit ? lastRow.createdAt.toISOString() : null;

  return NextResponse.json({
    events: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      actorUserId: r.actorUserId,
      kind: r.kind,
      targetType: r.targetType,
      targetId: r.targetId,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  });
}
