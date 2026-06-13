// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { parseScopeParam, scopeCond } from "@/lib/scope";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const collection = await db
    .select()
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.id, collectionId),
        inArray(schema.collections.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!collection.length) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ADR 0008 — scope default
  const __sc = scopeCond(parseScopeParam(new URL(_request.url).searchParams));
  const rows = await db
    .select({ asset: schema.assets })
    .from(schema.collectionAssets)
    .innerJoin(schema.assets, eq(schema.collectionAssets.assetId, schema.assets.id))
    .where(and(eq(schema.collectionAssets.collectionId, collectionId), __sc));

  return NextResponse.json({ assets: rows.map((r) => r.asset) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const body = (await request.json()) as { assetId: string };
  if (!body.assetId) return NextResponse.json({ error: "assetId required" }, { status: 400 });

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.id, collectionId),
        inArray(schema.collections.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!collection) return NextResponse.json({ error: "Collection not found" }, { status: 404 });

  // Phase 3.1 — editor required to mutate collection contents.
  const gate = await requireWorkspaceAccessOrResponse(user.id, collection.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const [link] = await db
    .insert(schema.collectionAssets)
    .values({ collectionId, assetId: body.assetId })
    .onConflictDoNothing()
    .returning();

  return NextResponse.json({ link }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const { searchParams } = request.nextUrl;
  const assetId = searchParams.get("assetId");
  if (!assetId) return NextResponse.json({ error: "assetId required" }, { status: 400 });

  // Phase 3.1 — editor required to remove assets from a collection. Look up
  // the collection's workspace first so the gate can run against the right id.
  const [collection] = await db
    .select({ workspaceId: schema.collections.workspaceId })
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.id, collectionId),
        inArray(schema.collections.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!collection) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, collection.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db
    .delete(schema.collectionAssets)
    .where(
      and(
        eq(schema.collectionAssets.collectionId, collectionId),
        eq(schema.collectionAssets.assetId, assetId)
      )
    );

  return NextResponse.json({ removed: true });
}
