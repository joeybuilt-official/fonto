import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ tags: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const tags = await db
    .select()
    .from(schema.tags)
    .where(inArray(schema.tags.workspaceId, workspaceIds));

  return NextResponse.json({ tags });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const body = (await request.json()) as { name: string; color?: string };
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [tag] = await db
    .insert(schema.tags)
    .values({
      workspaceId,
      name: body.name.trim().toLowerCase(),
      color: body.color ?? "#6366f1",
    })
    .returning();

  return NextResponse.json({ tag }, { status: 201 });
}
