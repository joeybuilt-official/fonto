// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { jsonSafe } from "@/lib/assets/createAssetRow";
import { cacheInvalidate } from "@/lib/cache/valkey";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({ tag: schema.tags })
    .from(schema.assetTags)
    .innerJoin(schema.tags, eq(schema.assetTags.tagId, schema.tags.id))
    .where(eq(schema.assetTags.assetId, assetId));

  // tags.seq is a bigint — jsonSafe it so JSON serialization doesn't throw.
  return NextResponse.json({ tags: jsonSafe(rows.map((r) => r.tag)) });
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

  // Ensure asset belongs to user's workspace
  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, assetId),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  const body = (await request.json()) as { tagId: string };
  if (!body.tagId) return NextResponse.json({ error: "tagId required" }, { status: 400 });

  const [link] = await db
    .insert(schema.assetTags)
    .values({ assetId, tagId: body.tagId })
    .onConflictDoNothing()
    .returning();

  // T1.3' — link change affects tags/top counts (+the assets-tag aggregate
  // path for symmetry w/ the rest of the surface).
  revalidateTag(`ws:${asset.workspaceId}:tags`, "max");
  revalidateTag(`ws:${asset.workspaceId}:assets`, "max");
  void cacheInvalidate(`ws:${asset.workspaceId}:tags`);
  void cacheInvalidate(`ws:${asset.workspaceId}:assets`);

  return NextResponse.json({ link }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const { searchParams } = request.nextUrl;
  const tagId = searchParams.get("tagId");
  if (!tagId) return NextResponse.json({ error: "tagId required" }, { status: 400 });

  // Look up the asset's workspace for the cache-tag invalidate below.
  const [asset] = await db
    .select({ workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, assetId),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  await db
    .delete(schema.assetTags)
    .where(
      and(
        eq(schema.assetTags.assetId, assetId),
        eq(schema.assetTags.tagId, tagId)
      )
    );

  // T1.3' — link change affects tags/top counts.
  if (asset) {
    revalidateTag(`ws:${asset.workspaceId}:tags`, "max");
    revalidateTag(`ws:${asset.workspaceId}:assets`, "max");
    void cacheInvalidate(`ws:${asset.workspaceId}:tags`);
    void cacheInvalidate(`ws:${asset.workspaceId}:assets`);
  }

  return NextResponse.json({ removed: true });
}
