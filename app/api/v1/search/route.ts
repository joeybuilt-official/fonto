// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, ilike, inArray, gte, lte, isNull, sql } from "drizzle-orm";
import { plexoMemorySearch } from "@/lib/plexo";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { deltaE76, parseHex, rgbToLab, type PaletteColor } from "@/lib/perceptual";
import { parseScopeParam, scopeCond } from "@/lib/scope";
import { getCacheLayer } from "@/lib/cache/valkey";

const COLOR_DELTA_E_THRESHOLD = 30;
const SEARCH_CACHE_TTL_SEC = 300;

// Chip names from the web filter popover + mobile filter sheet arrive as the
// color *name* (e.g. "red"); parseHex only understands hex, so map known names
// to their canonical hex before parsing. Keep in sync with COLOR_CHIPS in
// app/(app)/app/_components/filter-popover.tsx.
const COLOR_NAME_HEX: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
  brown: "#92400e",
  gray: "#6b7280",
  black: "#0a0a0a",
  white: "#fafafa",
};

// T2.1 — search results cache.
//
// Mutation routes that MUST call cacheInvalidate(`ws:${workspaceId}:assets`)
// when they touch asset rows (so cached search results don't go stale):
//   - POST /api/v1/uploads/[assetId]/complete (canonical upload complete)
//   - POST /api/v1/assets/[id]/complete       (legacy upload complete)
//   - DELETE /api/v1/assets/[id]              (asset delete)
//   - PATCH /api/v1/assets/[id]               (scope, classification, etc.)
//   - POST /api/v1/scope/reassign             (bulk scope flip)
//   - POST /api/v1/assets/[id]/tags           (tag a/dd remove on an asset)
//   - The processing pipeline finish step in lib/processing/processAsset.ts
// The parallel T1.3 work owns the actual wiring inside those handlers —
// listed here so its agent and this one share the same tag convention.
type CachedSearchResponse = {
  assets: ReturnType<typeof serializeAsset>[];
  total: number;
};

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) {
    return `[${input.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(input as Record<string, unknown>).sort();
  const obj = input as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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
  const scopeParam = parseScopeParam(searchParams);

  // Build the cache key from a STABLE digest of every input that affects the
  // result. workspaceIds are sorted before hashing so a user whose membership
  // returns in a different order still hits the same key. q is hashed
  // separately (per spec — `normalised_query`) so the key reads cleanly.
  const sortedWorkspaceIds = [...workspaceIds].sort();
  const primaryWorkspaceId = sortedWorkspaceIds[0] ?? "none";
  const queryHash = sha256(q.toLowerCase());
  const filtersHash = sha256(
    stableStringify({
      workspaceIds: sortedWorkspaceIds,
      mimeFilter,
      classification,
      tagId,
      correspondentId,
      documentTypeId,
      dateFrom,
      dateTo,
      semantic,
      ocrOnly,
      colorHex: colorHex.toLowerCase(),
      scope: scopeParam ?? "default",
    }),
  );
  const cacheKey = `search:${primaryWorkspaceId}:${queryHash}:${filtersHash}`;

  const cache = getCacheLayer<CachedSearchResponse>();
  const payload = await cache.getOrCompute(
    cacheKey,
    SEARCH_CACHE_TTL_SEC,
    () => runSearch(),
    {
      cacheName: "search",
      workspaceId: primaryWorkspaceId,
      // Tag with every workspace the result depends on so an asset mutation
      // in any of them flushes this entry.
      tags: sortedWorkspaceIds.map((id) => `ws:${id}:assets`),
    },
  );

  return NextResponse.json(payload);

  async function runSearch(): Promise<CachedSearchResponse> {
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
    if (!assetIds.length) return { assets: [], total: 0 };
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
    const resolved = COLOR_NAME_HEX[colorHex.toLowerCase()] ?? colorHex;
    const rgb = parseHex(resolved);
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

    return { assets: trimmed, total: trimmed.length };
  }
}
