// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b (UX consolidation follow-ups) — server-side fetch of the
// 3 most-recent albums for a workspace, scoped to the operator's
// active workspace and ordered by creation time.
//
// Called from `app/(app)/layout.tsx` so the sidebar can paint with the
// pin list already populated — no client-side flash. The data is
// passed as a serialisable prop through AppShell → AppSidebar (both
// are client components).
//
// Read-only. Mirrors the same `where workspaceId = ?` predicate as
// the GET /api/v1/collections endpoint at app/api/v1/collections/route.ts
// so the pinned list is always a subset of what the Collections page
// shows.

import { db, schema } from "@/lib/db";
import { desc, eq } from "drizzle-orm";

export interface RecentAlbum {
  id: string;
  name: string;
}

/** Number of pinned albums rendered under the Collections sidebar entry. */
export const RECENT_ALBUM_PIN_COUNT = 3;

export async function getRecentAlbumsForWorkspace(
  workspaceId: string,
): Promise<RecentAlbum[]> {
  const rows = await db
    .select({ id: schema.collections.id, name: schema.collections.name })
    .from(schema.collections)
    .where(eq(schema.collections.workspaceId, workspaceId))
    .orderBy(desc(schema.collections.createdAt))
    .limit(RECENT_ALBUM_PIN_COUNT);

  return rows;
}
