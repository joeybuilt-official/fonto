// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/collections/stats
// Returns item counts for all utility collection tiles on the
// Collections screen (Favorites, Trash, Screenshots, Archive, Documents).
// Five parallel COUNT queries, all hitting partial indexes — fast at
// any library size the partial indexes cover.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { and, count, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ favorites: 0, trash: 0, screenshots: 0, archived: 0, documents: 0 });
  }
  const wsIds = workspaces.map((w) => w.id);

  const [favRow, trashRow, screenshotRow, archiveRow, docRow] = await Promise.all([
    db
      .select({ c: count() })
      .from(schema.assets)
      .where(and(inArray(schema.assets.workspaceId, wsIds), eq(schema.assets.isFavorite, true), eq(schema.assets.lifecycleState, "active"))),
    db
      .select({ c: count() })
      .from(schema.assets)
      .where(and(inArray(schema.assets.workspaceId, wsIds), eq(schema.assets.lifecycleState, "trashed"))),
    db
      .select({ c: count() })
      .from(schema.assets)
      .where(and(inArray(schema.assets.workspaceId, wsIds), eq(schema.assets.kind, "screenshot"), eq(schema.assets.lifecycleState, "active"))),
    db
      .select({ c: count() })
      .from(schema.assets)
      .where(and(inArray(schema.assets.workspaceId, wsIds), eq(schema.assets.lifecycleState, "archived"))),
    db
      .select({ c: count() })
      .from(schema.assets)
      .where(and(inArray(schema.assets.workspaceId, wsIds), eq(schema.assets.kind, "document"), eq(schema.assets.lifecycleState, "active"))),
  ]);

  return NextResponse.json({
    favorites: Number(favRow[0]?.c ?? 0),
    trash: Number(trashRow[0]?.c ?? 0),
    screenshots: Number(screenshotRow[0]?.c ?? 0),
    archived: Number(archiveRow[0]?.c ?? 0),
    documents: Number(docRow[0]?.c ?? 0),
  });
}
