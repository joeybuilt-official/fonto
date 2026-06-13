// SPDX-License-Identifier: AGPL-3.0-only
// "More like this" — uses Plexo semantic memory to find similar assets.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, ne, isNull } from "drizzle-orm";
import { plexoAvailable, plexoMemorySearch } from "@/lib/plexo";
import { parseScopeParam, scopeCond } from "@/lib/scope";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  // ADR 0008 — scope default
  const __sc = scopeCond(parseScopeParam(new URL(_req.url).searchParams));

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds), isNull(schema.assets.deletedAt)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!plexoAvailable()) {
    // Fallback: same classification
    const similar = await db
      .select()
      .from(schema.assets)
      .where(
        and(
          inArray(schema.assets.workspaceId, workspaceIds),
          ne(schema.assets.id, id),
          isNull(schema.assets.deletedAt),
          eq(schema.assets.classification, asset.classification ?? ""),
          __sc
        )
      )
      .limit(10);
    return NextResponse.json({ assets: similar, source: "classification" });
  }

  const query = [asset.description, asset.extractedText, asset.filename]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);

  try {
    const results = await plexoMemorySearch(workspaceIds[0], query);
    const similarIds = results.map((r) => r.id).filter((rid) => rid !== id);

    if (!similarIds.length) {
      return NextResponse.json({ assets: [], source: "semantic" });
    }

    const similar = await db
      .select()
      .from(schema.assets)
      .where(
        and(
          inArray(schema.assets.id, similarIds),
          inArray(schema.assets.workspaceId, workspaceIds),
          isNull(schema.assets.deletedAt),
          __sc
        )
      )
      .limit(10);

    return NextResponse.json({ assets: similar, source: "semantic" });
  } catch {
    return NextResponse.json({ assets: [], source: "error" });
  }
}
