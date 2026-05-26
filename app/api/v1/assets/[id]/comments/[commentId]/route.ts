// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — single-comment endpoint.
//
//   DELETE /api/v1/assets/:id/comments/:commentId
//     Soft-delete: marks `deleted_at` so child replies don't orphan and
//     the audit trail stays intact. UI renders "[deleted]" in place of
//     the body; the API zeroes the body on the wire (see GET handler).
//
//     Allowed if the caller is the comment's author OR has editor+ role
//     on the workspace (editors can moderate). Viewer-only members
//     cannot delete even their own comment because viewers cannot post
//     in the first place — if a viewer's comment exists it predates a
//     role demotion, and we let editors clean it up.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { getUserWorkspaceRole } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { emitActivity } from "@/lib/activity/emit";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const { id: assetId, commentId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  // Single fetch: confirm asset is in caller's workspaces AND fetch the
  // target comment in the same SELECT.
  const [row] = await db
    .select({
      commentId: schema.comments.id,
      commentUserId: schema.comments.userId,
      commentDeletedAt: schema.comments.deletedAt,
      workspaceId: schema.assets.workspaceId,
    })
    .from(schema.comments)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.comments.assetId))
    .where(
      and(
        eq(schema.comments.id, commentId),
        eq(schema.comments.assetId, assetId),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Already deleted? Treat as idempotent — return 204 either way so the
  // UI can retry a delete that races a network failure.
  if (row.commentDeletedAt !== null) {
    return new NextResponse(null, { status: 204 });
  }

  const isAuthor = row.commentUserId === user.id;
  if (!isAuthor) {
    // Not the author — require editor+ to moderate.
    const role = await getUserWorkspaceRole(user.id, row.workspaceId);
    if (!role || (role !== "owner" && role !== "editor")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  await db
    .update(schema.comments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.comments.id, commentId), isNull(schema.comments.deletedAt)));

  void emitActivity({
    workspaceId: row.workspaceId,
    actorUserId: user.id,
    kind: "comment.deleted",
    targetType: "comment",
    targetId: commentId,
    payload: { assetId, byAuthor: isAuthor },
  });

  return new NextResponse(null, { status: 204 });
}
