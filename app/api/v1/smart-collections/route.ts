// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { inArray } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ smartCollections: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const smartCollections = await db
    .select()
    .from(schema.smartCollections)
    .where(inArray(schema.smartCollections.workspaceId, workspaceIds))
    .orderBy(schema.smartCollections.createdAt);

  return NextResponse.json({ smartCollections });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = await request.json() as { name?: string; query?: Record<string, unknown> };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [sc] = await db
    .insert(schema.smartCollections)
    .values({
      workspaceId: workspaces[0].id,
      userId: user.id,
      name,
      query: body.query ?? {},
    })
    .returning();

  return NextResponse.json({ smartCollection: sc }, { status: 201 });
}
