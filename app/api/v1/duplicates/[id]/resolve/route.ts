// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0010 — resolve a duplicate group: keep the best member, reversibly trash
// the confirmed dupes. Reuses commitConsolidation with requireAutoCommit:false
// so this explicit user action overrides the auto-gate that holds back
// automatic consolidation. Trashing carries a grace window and is undoable
// (lib/variants/undoConsolidation), so a near-miss is recoverable.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { commitConsolidation } from "@/lib/variants/consolidate";

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
    .select({ id: schema.variantGroups.id })
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

  const result = await commitConsolidation(id, { requireAutoCommit: false });
  return NextResponse.json(result);
}
