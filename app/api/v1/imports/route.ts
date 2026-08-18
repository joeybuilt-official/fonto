// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 (media import) — GET /api/v1/imports
//
// Lists recent import_jobs rows for the caller's workspace, newest first,
// so the /app/imports page can poll a single endpoint for progress across
// every in-flight and recently-finished import. Session-authed +
// workspace-scoped: only rows belonging to a workspace the caller is a
// member of are returned.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ imports: [] });
  }
  // Phase 4 keeps the UI single-workspace (it reads workspaces[0] everywhere),
  // so scope the list to the same primary workspace the other routes use.
  const workspace = workspaces[0];

  const rows = await db
    .select()
    .from(schema.importJobs)
    .where(eq(schema.importJobs.workspaceId, workspace.id))
    .orderBy(desc(schema.importJobs.createdAt))
    .limit(50);

  return NextResponse.json({
    imports: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      status: row.status,
      itemsTotal: row.itemsTotal,
      itemsProcessed: row.itemsProcessed,
      itemsDeduped: row.itemsDeduped,
      itemsFailed: row.itemsFailed,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  });
}
