// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, count, isNull } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionId } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.id, collectionId),
        inArray(schema.collections.workspaceId, workspaceIds),
        isNull(schema.collections.deletedAt)
      )
    )
    .limit(1);

  if (!collection) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [{ assetCount }] = await db
    .select({ assetCount: count() })
    .from(schema.collectionAssets)
    .where(eq(schema.collectionAssets.collectionId, collectionId));

  return NextResponse.json({ collection: { ...collection, assetCount } });
}
