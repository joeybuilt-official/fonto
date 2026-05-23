// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, inArray, desc } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ projects: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const projects = await db
    .select()
    .from(schema.projects)
    .where(inArray(schema.projects.workspaceId, workspaceIds))
    .orderBy(desc(schema.projects.updatedAt));

  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Phase 3.1 — editor required to create projects.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaces[0].id, "editor");
  if (!gate.ok) return gate.response;

  const body = await request.json() as { name?: string; description?: string; color?: string };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [project] = await db
    .insert(schema.projects)
    .values({
      workspaceId: workspaces[0].id,
      userId: user.id,
      name,
      description: String(body.description ?? ""),
      color: body.color ?? "#6366f1",
    })
    .returning();

  return NextResponse.json({ project }, { status: 201 });
}
