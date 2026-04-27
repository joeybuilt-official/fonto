// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, ilike, inArray, gte, lte, isNull, sql } from "drizzle-orm";
import { plexoMemorySearch } from "@/lib/plexo";

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  const mimeFilter = searchParams.get("mime") ?? "";
  const classification = searchParams.get("classification") ?? "";
  const tagId = searchParams.get("tagId") ?? "";
  const correspondentId = searchParams.get("correspondentId") ?? "";
  const documentTypeId = searchParams.get("documentTypeId") ?? "";
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";
  const semantic = searchParams.get("semantic") === "true";

  const conditions = [
    inArray(schema.assets.workspaceId, workspaceIds),
    isNull(schema.assets.deletedAt),
  ];

  if (classification) conditions.push(eq(schema.assets.classification, classification));
  if (correspondentId) conditions.push(eq(schema.assets.correspondentId, correspondentId));
  if (documentTypeId) conditions.push(eq(schema.assets.documentTypeId, documentTypeId));
  if (dateFrom) conditions.push(gte(schema.assets.createdAt, new Date(dateFrom)));
  if (dateTo) conditions.push(lte(schema.assets.createdAt, new Date(dateTo)));
  if (mimeFilter) conditions.push(sql`${schema.assets.mimeType} LIKE ${mimeFilter + "%"}`);

  if (q) {
    // Postgres FTS on extracted_text, fallback ilike on other fields
    const ftsCondition = sql`to_tsvector('english', coalesce(${schema.assets.extractedText}, '') || ' ' || coalesce(${schema.assets.description}, '') || ' ' || ${schema.assets.filename}) @@ plainto_tsquery('english', ${q})`;
    const ilikeCondition = or(
      ilike(schema.assets.filename, `%${q}%`),
      ilike(schema.assets.description, `%${q}%`),
      ilike(schema.assets.extractedText, `%${q}%`),
      ilike(schema.assets.classification, `%${q}%`)
    )!;
    conditions.push(or(ftsCondition, ilikeCondition)!);
  }

  let assetIds: string[] | null = null;

  // Tag filter via join
  if (tagId) {
    const taggedAssets = await db
      .select({ assetId: schema.assetTags.assetId })
      .from(schema.assetTags)
      .where(eq(schema.assetTags.tagId, tagId));
    assetIds = taggedAssets.map((r) => r.assetId);
    if (!assetIds.length) return NextResponse.json({ assets: [], total: 0 });
    conditions.push(inArray(schema.assets.id, assetIds));
  }

  let assets = await db
    .select()
    .from(schema.assets)
    .where(and(...conditions))
    .orderBy(schema.assets.createdAt)
    .limit(100);

  // Semantic re-ranking via Plexo if requested and query given
  if (semantic && q && assets.length > 0) {
    try {
      const semanticResults = await plexoMemorySearch(workspaceIds[0], q);
      const semanticIds = new Set(semanticResults.map((r) => r.id));
      // Surface semantic matches first, then rest
      const scored = assets.sort((a, b) => {
        const aScore = semanticIds.has(a.id) ? 1 : 0;
        const bScore = semanticIds.has(b.id) ? 1 : 0;
        return bScore - aScore;
      });
      assets = scored;
    } catch {
      // non-fatal: fall through with unranked results
    }
  }

  return NextResponse.json({ assets, total: assets.length });
}
