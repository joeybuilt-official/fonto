// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0010 — undo (un-consolidate) a duplicate group: the reverse of
// /duplicates/{id}/resolve. Clears the `consolidation_state='trashed'` +
// trash_purge_at grace stamp on every member the resolve trashed, drops the
// canonical flag, and reverts the group to `candidate` so it resurfaces in the
// review queue. Reversible safety net before the grace-window purge runs.
//
// Workspace-scoped: the group must belong to one of the caller's workspaces.
// Delegates to lib/variants/consolidate#undoConsolidation (the same helper the
// worker uses), so mobile can offer a one-tap Undo after a resolve.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { undoConsolidation } from "@/lib/variants/consolidate";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // The group must belong to one of the caller's workspaces.
  const [group] = await db
    .select({ id: schema.variantGroups.id, workspaceId: schema.variantGroups.workspaceId })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.id, id),
        inArray(
          schema.variantGroups.workspaceId,
          workspaces.map((w) => w.id),
        ),
      ),
    )
    .limit(1);
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Reversing a consolidation restores trashed rows — an editor-level write.
  const gate = await requireWorkspaceAccessOrResponse(user.id, group.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const result = await undoConsolidation(id);
  return NextResponse.json({ groupId: id, ...result });
}
