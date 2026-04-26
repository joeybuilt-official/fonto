import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, sum } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspace = workspaces[0];

  const [stats] = await db
    .select({ totalBytes: sum(schema.assets.sizeBytes) })
    .from(schema.assets)
    .where(eq(schema.assets.workspaceId, workspace.id));

  const assetCounts = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.workspaceId, workspace.id));

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    },
    storage: {
      totalBytes: Number(stats?.totalBytes ?? 0),
      assetCount: assetCounts.length,
    },
  });
}
