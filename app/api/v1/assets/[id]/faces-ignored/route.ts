// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// PATCH /api/v1/assets/:id/faces-ignored
//
// Body: { ignored: boolean }
//
// Photo-level face ignore (faces/UX). Marks a photo "no faces here":
// detection is skipped going forward (detectFaces guard) and the photo's
// existing faces are hidden so they drop out of the People view + future
// clustering. Un-ignoring restores both.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";

interface PatchBody {
  ignored?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, asset.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  if (typeof body.ignored !== "boolean") {
    return NextResponse.json({ error: "ignored must be boolean" }, { status: 400 });
  }
  const ignored = body.ignored;

  await db
    .update(schema.assets)
    .set({ facesIgnored: ignored })
    .where(eq(schema.assets.id, asset.id));

  // Cascade to the photo's faces so they leave / rejoin the People view and
  // clustering (which excludes hidden faces).
  await db
    .update(schema.faceInstances)
    .set({ hidden: ignored })
    .where(eq(schema.faceInstances.assetId, asset.id));

  return NextResponse.json({ ok: true as const, facesIgnored: ignored });
}
