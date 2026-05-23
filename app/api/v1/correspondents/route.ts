// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ correspondents: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const correspondents = await db
    .select()
    .from(schema.correspondents)
    .where(inArray(schema.correspondents.workspaceId, workspaceIds))
    .orderBy(schema.correspondents.name);

  return NextResponse.json({ correspondents });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Phase 3.1 — editor required to create correspondents.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaces[0].id, "editor");
  if (!gate.ok) return gate.response;

  const body = await request.json() as { name?: string; matchPattern?: string };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [correspondent] = await db
    .insert(schema.correspondents)
    .values({
      workspaceId: workspaces[0].id,
      name,
      matchPattern: body.matchPattern ?? null,
    })
    .returning();

  return NextResponse.json({ correspondent }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const workspaceIds = workspaces.map((w) => w.id);

  const body = await request.json() as { id: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Phase 3.1 — editor required to delete a correspondent. Resolve its
  // workspace first so the gate runs against the right id.
  const [existing] = await db
    .select({ workspaceId: schema.correspondents.workspaceId })
    .from(schema.correspondents)
    .where(and(eq(schema.correspondents.id, body.id), inArray(schema.correspondents.workspaceId, workspaceIds)))
    .limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db
    .delete(schema.correspondents)
    .where(and(eq(schema.correspondents.id, body.id), inArray(schema.correspondents.workspaceId, workspaceIds)));

  return NextResponse.json({ ok: true });
}
