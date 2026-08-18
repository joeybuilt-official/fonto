// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — GET /api/v1/imports/:id
//
// Returns one import_jobs row for progress polling. Session-authed +
// workspace-scoped: the row must belong to a workspace the caller is a member
// of, else 404 (don't leak existence across workspaces).
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const workspaceIds = new Set(workspaces.map((w) => w.id));

  const [row] = await db
    .select()
    .from(schema.importJobs)
    .where(eq(schema.importJobs.id, id))
    .limit(1);

  if (!row || !workspaceIds.has(row.workspaceId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
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
  });
}
