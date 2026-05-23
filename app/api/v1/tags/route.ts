// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { emitWebhook } from "@/lib/webhooks/emit";
import { nextSeq } from "@/lib/db/seq";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ tags: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const tags = await db
    .select()
    .from(schema.tags)
    .where(inArray(schema.tags.workspaceId, workspaceIds));

  return NextResponse.json({ tags });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  // Phase 3.1 — editor required to create tags.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json()) as { name: string; color?: string };
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  // Phase 2.3 — allocate delta-sync seq for this new tag.
  const seq = await nextSeq(workspaceId, "tag");
  const [tag] = await db
    .insert(schema.tags)
    .values({
      workspaceId,
      name: body.name.trim().toLowerCase(),
      color: body.color ?? "#6366f1",
      seq,
    })
    .returning();

  // Phase 2.4 — outbound webhook (tag.created).
  await emitWebhook(workspaceId, "tag.created", {
    tagId: tag.id,
    workspaceId,
    name: tag.name,
    color: tag.color,
    aiSuggested: tag.aiSuggested,
    createdAt: tag.createdAt.toISOString(),
  });

  return NextResponse.json({ tag }, { status: 201 });
}
