import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, ilike, inArray, ne } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  const mimeFilter = searchParams.get("mime") ?? "";
  const lifecycle = searchParams.get("lifecycle") ?? "active";
  const source = searchParams.get("source") ?? "";

  const conditions = [
    inArray(schema.assets.workspaceId, workspaceIds),
    ne(schema.assets.lifecycleState, "trashed"),
  ];

  if (lifecycle) {
    const valid = ["active", "archivable", "archived"];
    if (valid.includes(lifecycle)) {
      conditions.push(eq(schema.assets.lifecycleState, lifecycle));
    }
  }

  if (source) {
    conditions.push(eq(schema.assets.source, source));
  }

  if (q) {
    conditions.push(
      or(
        ilike(schema.assets.filename, `%${q}%`),
        ilike(schema.assets.description, `%${q}%`),
        ilike(schema.assets.extractedText, `%${q}%`),
        ilike(schema.assets.classification, `%${q}%`)
      )!
    );
  }

  let rows = await db
    .select()
    .from(schema.assets)
    .where(and(...conditions))
    .limit(50);

  if (mimeFilter) {
    rows = rows.filter((a) => a.mimeType.startsWith(mimeFilter));
  }

  return NextResponse.json({ assets: rows, total: rows.length });
}
