// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nextSeq } from "@/lib/db/seq";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ collections: [] });

  const rows = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.workspaceId, workspaces[0].id))
    .orderBy(schema.collections.createdAt);

  return NextResponse.json({ collections: rows });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }

  const body = await request.json();
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  // Phase 2.3 — allocate delta-sync seq for this new collection.
  const seq = await nextSeq(workspaces[0].id, "collection");
  const [collection] = await db
    .insert(schema.collections)
    .values({
      workspaceId: workspaces[0].id,
      userId: user.id,
      name,
      description: String(body.description ?? ""),
      seq,
    })
    .returning();

  return NextResponse.json({ collection }, { status: 201 });
}
