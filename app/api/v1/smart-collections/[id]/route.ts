// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [sc] = await db
    .select()
    .from(schema.smartCollections)
    .where(and(eq(schema.smartCollections.id, id), inArray(schema.smartCollections.workspaceId, workspaceIds)))
    .limit(1);
  if (!sc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ smartCollection: sc });
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

  const body = await request.json() as { name?: string; query?: Record<string, unknown> };
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.query !== undefined) updates.query = body.query;

  const [updated] = await db
    .update(schema.smartCollections)
    .set(updates)
    .where(and(eq(schema.smartCollections.id, id), inArray(schema.smartCollections.workspaceId, workspaceIds)))
    .returning();
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ smartCollection: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [deleted] = await db
    .delete(schema.smartCollections)
    .where(and(eq(schema.smartCollections.id, id), inArray(schema.smartCollections.workspaceId, workspaceIds)))
    .returning({ id: schema.smartCollections.id });
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
