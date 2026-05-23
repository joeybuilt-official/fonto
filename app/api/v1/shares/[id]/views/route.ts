// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/shares/:id/views — last 50 access events for a share link.
// Only the workspace owner can read. Raw IPs are never returned (only ipHash).

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ views: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  // Verify caller owns the link.
  const [link] = await db
    .select({ id: schema.shareLinks.id })
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.id, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const views = await db
    .select()
    .from(schema.shareLinkViews)
    .where(eq(schema.shareLinkViews.shareLinkId, id))
    .orderBy(desc(schema.shareLinkViews.accessedAt))
    .limit(50);

  return NextResponse.json({ views });
}
