// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Per-share-link operations.
//
//   DELETE /api/v1/shares/:id           — revoke (soft; sets revoked=true,
//                                          keeps the row + view history)
//   GET    /api/v1/shares/:id/views     — recent access events (see views/route.ts)

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  // Phase 3.1 — revoking a share is a mutation; resolve the link's workspace
  // and gate on editor.
  const [link] = await db
    .select({ workspaceId: schema.shareLinks.workspaceId })
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.id, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const gate = await requireWorkspaceAccessOrResponse(user.id, link.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const result = await db
    .update(schema.shareLinks)
    .set({ revoked: true, revokedAt: new Date() })
    .where(
      and(
        eq(schema.shareLinks.id, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds),
        eq(schema.shareLinks.revoked, false)
      )
    )
    .returning({ id: schema.shareLinks.id });

  if (!result.length) {
    return NextResponse.json({ error: "Not found or already revoked" }, { status: 404 });
  }

  // TODO: bump assets.seq via nextSeq() once 2.3 lands. TODO: emit
  // "share.revoked" webhook event once 2.4 lands.

  return NextResponse.json({ revoked: true });
}
