// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ documentTypes: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const documentTypes = await db
    .select()
    .from(schema.documentTypes)
    .where(inArray(schema.documentTypes.workspaceId, workspaceIds))
    .orderBy(schema.documentTypes.name);

  return NextResponse.json({ documentTypes });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = await request.json() as { name?: string; matchPattern?: string };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [documentType] = await db
    .insert(schema.documentTypes)
    .values({
      workspaceId: workspaces[0].id,
      name,
      matchPattern: body.matchPattern ?? null,
    })
    .returning();

  return NextResponse.json({ documentType }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const workspaceIds = workspaces.map((w) => w.id);

  const body = await request.json() as { id: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await db
    .delete(schema.documentTypes)
    .where(and(eq(schema.documentTypes.id, body.id), inArray(schema.documentTypes.workspaceId, workspaceIds)));

  return NextResponse.json({ ok: true });
}
