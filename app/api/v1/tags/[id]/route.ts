// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M10 / ADR 0013 — rename + reparent a tag. Rename is id-based-path-safe (no
// cascade). Reparent rewrites the moved node's whole subtree path in one
// UPDATE, with cycle + depth guards, and bumps delta-sync seq for every moved
// row so clients pick up the new path. Editor required.
//
// Both guards are the tag tree's, not the transport's: they live in
// `lib/tags/store.ts` beside the rewrite they protect.

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { cacheInvalidate } from "@/lib/cache/valkey";
import { parseJson } from "@/app/api/v1/_lib/parseJson";
import { TagRuleError, updateTag } from "@/lib/tags/store";

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

  const parsed = await parseJson<{
    name?: string;
    color?: string;
    parentId?: string | null;
  }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  let updated;
  try {
    updated = await updateTag(workspaceId, id, {
      name: body.name,
      color: body.color,
      parentId: body.parentId,
      reparent: Object.prototype.hasOwnProperty.call(body, "parentId"),
    });
  } catch (err) {
    if (err instanceof TagRuleError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  revalidateTag(`ws:${workspaceId}:tags`, "max");
  void cacheInvalidate(`ws:${workspaceId}:tags`);
  return NextResponse.json({ tag: updated });
}
