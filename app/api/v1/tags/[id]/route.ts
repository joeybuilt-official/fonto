// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M10 / ADR 0013 — rename + reparent a tag. Rename is id-based-path-safe (no
// cascade). Reparent rewrites the moved node's whole subtree path in one
// UPDATE, with cycle + depth guards, and bumps delta-sync seq for every moved
// row so clients pick up the new path. Editor required.

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { nextSeq } from "@/lib/db/seq";
import { cacheInvalidate } from "@/lib/cache/valkey";
import { childPath, pathDepth, TAG_DEPTH_LIMIT } from "@/lib/tags/tree";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const [tag] = await db
    .select()
    .from(schema.tags)
    .where(and(eq(schema.tags.id, id), eq(schema.tags.workspaceId, workspaceId)))
    .limit(1);
  if (!tag) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = await parseJson<{
    name?: string;
    color?: string;
    parentId?: string | null;
  }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const fields: { name?: string; color?: string } = {};
  if (typeof body.name === "string" && body.name.trim()) fields.name = body.name.trim().toLowerCase();
  if (typeof body.color === "string") fields.color = body.color;

  const reparenting = Object.prototype.hasOwnProperty.call(body, "parentId");

  // --- Rename / recolour only (no move) -------------------------------------
  if (!reparenting) {
    const seq = await nextSeq(workspaceId, "tag");
    const [updated] = await db
      .update(schema.tags)
      .set({ ...fields, seq })
      .where(eq(schema.tags.id, id))
      .returning();
    revalidateTag(`ws:${workspaceId}:tags`, "max");
    void cacheInvalidate(`ws:${workspaceId}:tags`);
    return NextResponse.json({ tag: updated });
  }

  // --- Reparent (subtree path rewrite) --------------------------------------
  const newParentId = body.parentId ?? null;
  if (newParentId === id)
    return NextResponse.json({ error: "a tag cannot be its own parent" }, { status: 400 });

  let newParentPath: string | null = null;
  if (newParentId) {
    const [parent] = await db
      .select({ id: schema.tags.id, path: schema.tags.path })
      .from(schema.tags)
      .where(and(eq(schema.tags.id, newParentId), eq(schema.tags.workspaceId, workspaceId)))
      .limit(1);
    if (!parent) return NextResponse.json({ error: "parent not found" }, { status: 400 });
    // Cycle guard: the new parent must not be this tag or anything beneath it.
    if (parent.path.startsWith(tag.path))
      return NextResponse.json({ error: "cannot move a tag under its own descendant" }, { status: 400 });
    newParentPath = parent.path;
  }

  const oldSelfPath = tag.path;
  const newSelfPath = childPath(newParentPath, id);
  if (newSelfPath === oldSelfPath) {
    // No-op move (already there). Apply any rename/colour and return.
    const seq = await nextSeq(workspaceId, "tag");
    const [updated] = await db
      .update(schema.tags)
      .set({ ...fields, seq })
      .where(eq(schema.tags.id, id))
      .returning();
    revalidateTag(`ws:${workspaceId}:tags`, "max");
    void cacheInvalidate(`ws:${workspaceId}:tags`);
    return NextResponse.json({ tag: updated });
  }

  // Depth guard: the deepest descendant after the move must fit the cap.
  const descendants = await db
    .select({ id: schema.tags.id, path: schema.tags.path })
    .from(schema.tags)
    .where(and(eq(schema.tags.workspaceId, workspaceId), sql`${schema.tags.path} LIKE ${oldSelfPath + "%"}`));
  const oldSelfDepth = pathDepth(oldSelfPath);
  const subtreeHeight = descendants.reduce((m, d) => Math.max(m, pathDepth(d.path) - oldSelfDepth), 0);
  if (pathDepth(newSelfPath) + subtreeHeight > TAG_DEPTH_LIMIT)
    return NextResponse.json({ error: "move would exceed max nesting depth" }, { status: 400 });

  await db.transaction(async (tx) => {
    // Rewrite every subtree row's path: newSelfPath || (path minus oldSelfPath).
    await tx
      .update(schema.tags)
      .set({
        path: sql`${newSelfPath} || substring(${schema.tags.path} from ${oldSelfPath.length + 1})`,
      })
      .where(and(eq(schema.tags.workspaceId, workspaceId), sql`${schema.tags.path} LIKE ${oldSelfPath + "%"}`));
    // Set the moved node's parent edge.
    await tx.update(schema.tags).set({ parentId: newParentId, ...fields }).where(eq(schema.tags.id, id));
    // Bump seq for every moved row so delta-sync clients pick up the new path.
    for (const d of descendants) {
      const seq = await nextSeq(workspaceId, "tag");
      await tx.update(schema.tags).set({ seq }).where(eq(schema.tags.id, d.id));
    }
  });

  const [updated] = await db.select().from(schema.tags).where(eq(schema.tags.id, id)).limit(1);
  revalidateTag(`ws:${workspaceId}:tags`, "max");
  void cacheInvalidate(`ws:${workspaceId}:tags`);
  return NextResponse.json({ tag: updated });
}
