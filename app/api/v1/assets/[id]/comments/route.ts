// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — asset comments collection endpoint.
//
//   GET  /api/v1/assets/:id/comments  — list all (non-deleted-body) comments
//                                       on the asset, oldest-first, ready
//                                       to build a parent→reply tree client-
//                                       side.
//   POST /api/v1/assets/:id/comments  — post a new comment (top-level or
//                                       reply via `parentId`).
//
// Authz: viewer can read; editor or higher can post (matches asset-mutation
// gates on /api/v1/assets POST). The asset itself must live in a workspace
// the caller has membership in — 404 otherwise.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { emitActivity } from "@/lib/activity/emit";

const MAX_BODY_LENGTH = 10_240;

interface SerializedComment {
  id: string;
  assetId: string;
  workspaceId: string;
  userId: string;
  body: string;
  parentId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function serializeComment(row: typeof schema.comments.$inferSelect): SerializedComment {
  const isDeleted = row.deletedAt !== null;
  return {
    id: row.id,
    assetId: row.assetId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    // Zero out the body on the wire for soft-deleted rows so the UI can
    // render "[deleted]" without the original content ever leaving the
    // server. Authors can still recover from `deletedAt` if a future
    // un-delete flow lands.
    body: isDeleted ? "" : row.body,
    parentId: row.parentId,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  // Look up the asset under any workspace the caller has membership in.
  // 404 if the asset doesn't exist or isn't in one of those workspaces —
  // we don't leak existence to non-members.
  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.assetId, assetId))
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id));

  return NextResponse.json({
    comments: rows.map(serializeComment),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase 7b — relaxed from editor → commenter. Anyone at commenter or
  // higher can post; viewer-only members get 403, non-members 404.
  const gate = await requireWorkspaceAccessOrResponse(user.id, asset.workspaceId, "commenter");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as {
    body?: unknown;
    parentId?: unknown;
  } | null;
  if (!body || typeof body.body !== "string") {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  const text = body.body.trim();
  if (text.length === 0) {
    return NextResponse.json({ error: "Empty comment" }, { status: 400 });
  }
  if (text.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { error: `Comment exceeds ${MAX_BODY_LENGTH} character limit` },
      { status: 413 }
    );
  }

  // Optional `parentId` for threading. Must reference an existing comment
  // on this same asset — cross-asset replies would corrupt the thread UI.
  let parentId: string | null = null;
  if (body.parentId != null) {
    if (typeof body.parentId !== "string") {
      return NextResponse.json({ error: "parentId must be a string" }, { status: 400 });
    }
    const [parent] = await db
      .select({ id: schema.comments.id })
      .from(schema.comments)
      .where(and(eq(schema.comments.id, body.parentId), eq(schema.comments.assetId, assetId)))
      .limit(1);
    if (!parent) {
      return NextResponse.json({ error: "Parent comment not found on this asset" }, { status: 400 });
    }
    parentId = parent.id;
  }

  const [inserted] = await db
    .insert(schema.comments)
    .values({
      workspaceId: asset.workspaceId,
      assetId,
      userId: user.id,
      body: text,
      parentId,
    })
    .returning();

  void emitActivity({
    workspaceId: asset.workspaceId,
    actorUserId: user.id,
    kind: "comment.posted",
    targetType: "comment",
    targetId: inserted.id,
    payload: {
      assetId,
      // Truncated excerpt for the digest renderer — keeps activity_events
      // payloads bounded even if a 10 KB comment lands.
      excerpt: text.slice(0, 240),
      parentId,
    },
  });

  return NextResponse.json({ comment: serializeComment(inserted) }, { status: 201 });
}
