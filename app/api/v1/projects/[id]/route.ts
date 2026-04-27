// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, desc } from "drizzle-orm";

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

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, id), inArray(schema.projects.workspaceId, workspaceIds)))
    .limit(1);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const collections = await db
    .select()
    .from(schema.collections)
    .where(and(eq(schema.collections.projectId, id), inArray(schema.collections.workspaceId, workspaceIds)))
    .orderBy(schema.collections.sortOrder, schema.collections.createdAt);

  return NextResponse.json({ project, collections });
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

  const body = await request.json() as { name?: string; description?: string; color?: string };
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.description !== undefined) updates.description = String(body.description);
  if (body.color !== undefined) updates.color = body.color;

  const [updated] = await db
    .update(schema.projects)
    .set(updates)
    .where(and(eq(schema.projects.id, id), inArray(schema.projects.workspaceId, workspaceIds)))
    .returning();
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ project: updated });
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

  // Detach collections from project before deleting
  await db
    .update(schema.collections)
    .set({ projectId: null })
    .where(and(eq(schema.collections.projectId, id), inArray(schema.collections.workspaceId, workspaceIds)));

  const [deleted] = await db
    .delete(schema.projects)
    .where(and(eq(schema.projects.id, id), inArray(schema.projects.workspaceId, workspaceIds)))
    .returning({ id: schema.projects.id });
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
