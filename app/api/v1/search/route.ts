// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, ilike, inArray, gte, lte, isNull, sql } from "drizzle-orm";
import { plexoMemorySearch } from "@/lib/plexo";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { deltaE76, parseHex, rgbToLab, type PaletteColor } from "@/lib/perceptual";
import { parseScopeParam, scopeCond } from "@/lib/scope";

const COLOR_DELTA_E_THRESHOLD = 30;

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
  const ocrOnly = searchParams.get("ocrOnly") === "true";
  const colorHex = searchParams.get("color")?.trim() ?? "";

  const conditions = [
    inArray(schema.assets.workspaceId, workspaceIds),
    isNull(schema.assets.deletedAt),
  ];
  // ADR 0008 — scope default
  const __sc = scopeCond(parseScopeParam(searchParams));
  if (__sc) conditions.push(__sc);

  if (classification) conditions.push(eq(schema.assets.classification, classification));
  if (correspondentId) conditions.push(eq(schema.assets.correspondentId, correspondentId));
  if (documentTypeId) conditions.push(eq(schema.assets.documentTypeId, documentTypeId));
  if (dateFrom) conditions.push(gte(schema.assets.createdAt, new Date(dateFrom)));
  if (dateTo) conditions.push(lte(schema.assets.createdAt, new Date(dateTo)));
  if (mimeFilter) conditions.push(sql`${schema.assets.mimeType} LIKE ${mimeFilter + "%"}`);

  if (q) {
    if (ocrOnly) {
      // OCR-only mode: query only fonto.assets.ocr_text via tsvector. Use the
      // GIN index `assets_ocr_text_fts_idx`. plainto_tsquery handles tokens
      // gracefully (no special-char crashes).
      const ocrCondition = sql`to_tsvector('english', coalesce(${schema.assets.ocrText}, '')) @@ plainto_tsquery('english', ${q})`;
      conditions.push(ocrCondition);
    } else {
      // Postgres FTS on extracted_text + ocr_text, fallback ilike on other fields
      const ftsCondition = sql`to_tsvector('english', coalesce(${schema.assets.extractedText}, '') || ' ' || coalesce(${schema.assets.ocrText}, '') || ' ' || coalesce(${schema.assets.description}, '') || ' ' || ${schema.assets.filename}) @@ plainto_tsquery('english', ${q})`;
      const ilikeCondition = or(
        ilike(schema.assets.filename, `%${q}%`),
        ilike(schema.assets.description, `%${q}%`),
        ilike(schema.assets.extractedText, `%${q}%`),
        ilike(schema.assets.ocrText, `%${q}%`),
        ilike(schema.assets.classification, `%${q}%`)
      )!;
      conditions.push(or(ftsCondition, ilikeCondition)!);
    }
  } else if (ocrOnly) {
    // OCR-only with no query: only return assets that have OCR text at all.
    conditions.push(sql`${schema.assets.ocrText} IS NOT NULL AND length(${schema.assets.ocrText}) > 0`);
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
    .limit(500);

  // Color filter — applied in JS after the SQL pull because Postgres can't
  // efficiently compute Lab ΔE in pure SQL. Limit raised to 500 above so
  // the JS filter has enough headroom; we still cap output at 100.
  if (colorHex) {
    const rgb = parseHex(colorHex);
    if (rgb) {
      const targetLab = rgbToLab(rgb[0], rgb[1], rgb[2]);
      assets = assets.filter((a) => {
        const palette = a.colors as PaletteColor[] | null;
        if (!palette || palette.length === 0) return false;
        for (const c of palette) {
          const cRgb = parseHex(c.hex);
          if (!cRgb) continue;
          const lab = rgbToLab(cRgb[0], cRgb[1], cRgb[2]);
          if (deltaE76(targetLab, lab) <= COLOR_DELTA_E_THRESHOLD) return true;
        }
        return false;
      });
    }
  }

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

  // Cap to 100 and serialize via serializeAsset — handles ALL bigint columns
  // (phash AND seq). The previous hand-rolled map only converted phash, so the
  // unconverted `seq` bigint threw "Do not know how to serialize a BigInt" and
  // 500'd every search.
  const trimmed = assets.slice(0, 100).map((a) => serializeAsset(a));

  return NextResponse.json({ assets: trimmed, total: trimmed.length });
}
