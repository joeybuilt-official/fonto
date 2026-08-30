// SPDX-License-Identifier: MIT
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, asc, ilike, inArray, gte, lte, isNull, sql, getTableColumns } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { plexoMemorySearch } from "@/lib/plexo";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { deltaE76, parseHex, rgbToLab, type PaletteColor } from "@/lib/perceptual";
import { parseScopeParam, scopeCond } from "@/lib/scope";
import { exifFilterConditions, EXIF_FILTER_KEYS } from "@/lib/assets/exifFilters";
import { getCacheLayer } from "@/lib/cache/valkey";

const COLOR_DELTA_E_THRESHOLD = 30;
const SEARCH_CACHE_TTL_SEC = 300;
const PAGE_SIZE = 100;
// Color-ΔE / semantic modes re-shape the result set in JS after the SQL cut, so
// they can't page; they scan a wider window and return one capped page.
const UNPAGED_SCAN_LIMIT = 500;

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
  // Item count in THIS page. Not a total-match count — see the field-rename
  // note on the route handler for why.
  count: number;
  // Opaque next-page cursor; null in the excluded modes and once the last row
  // has been served (including a final page that is exactly PAGE_SIZE long).
  cursor: string | null;
  // True when results were cut off and there is no cursor to continue with, so
  // the client can render "showing the first N matches".
  truncated: boolean;
};

// Opaque keyset cursor, same base64url(JSON({ s, b, i })) idiom as
// /api/v1/assets: s = sort axis, b = last row's createdAt AT FULL STORED
// PRECISION (Postgres `timestamptz::text`, microseconds — NOT a JS Date ISO
// string, which only carries milliseconds and would silently drop the
// fractional-microsecond remainder), i = last row's id (tie-break). Search has
// ONE axis (createdAt ASC), so `s` is a literal here; sharing the /assets
// helper would mean lifting its 5-value SortAxis union out of that route,
// which is a bigger change than a decode function. Only plain/FTS search
// pages — the color-ΔE filter and the Plexo semantic re-rank both mutate the
// result set after the SQL cut, so a keyset walked across them would skip and
// duplicate rows.
type SearchCursor = { s: "created"; b: string; i: string };
function encodeCursor(p: SearchCursor): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
// `b` is validated as a plausible `timestamptz`-text shape only — never run
// through `Date.parse`/`new Date()`. This value is compared in SQL as
// `${b}::timestamptz`, so a JS Date round-trip (millisecond precision) would
// reintroduce the exact bug this cursor exists to fix.
// Matches both the legacy `timestamptz::text` output (space-separated,
// numeric UTC offset — session-DateStyle-dependent, kept only so a cursor
// issued before the `to_char` fix below still decodes) and the current
// `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` mask (T-separated, literal Z).
const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)$/;
// `i` is bound into `${schema.assets.id} > ${cursor.i}` against a uuid
// column — an unvalidated string there surfaces as an unhandled Postgres
// "invalid input syntax for type uuid" (500) instead of the 400 a malformed
// cursor should produce.
const cursorIdSchema = z.string().uuid();
function decodeCursor(raw: string): SearchCursor | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      p?.s === "created" &&
      typeof p?.b === "string" &&
      TIMESTAMPTZ_TEXT_RE.test(p.b) &&
      typeof p?.i === "string" &&
      cursorIdSchema.safeParse(p.i).success
    ) {
      return p as SearchCursor;
    }
  } catch {
    // fall through — malformed cursor is rejected at the boundary below
  }
  return null;
}

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
  if (!workspaces.length) {
    return NextResponse.json({ assets: [], count: 0, cursor: null, truncated: false } satisfies CachedSearchResponse);
  }
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
  // Reject an unparseable `color` at the boundary rather than silently
  // falling back to plain mode: `paginated` below is derived from
  // `colorHex` being non-empty, so a bad value that fell through would
  // still disable cursor paging while `truncated` kept claiming a
  // color-filtered cutoff happened — an incoherent response shape for a
  // request the caller can simply be told to fix.
  const resolvedColorRgb = colorHex ? parseHex(COLOR_NAME_HEX[colorHex.toLowerCase()] ?? colorHex) : null;
  if (colorHex && !resolvedColorRgb) {
    logger.child({ component: "search" }).warn({ userId: user.id, colorHex }, "rejected malformed search color filter");
    return NextResponse.json({ error: "Invalid color filter" }, { status: 400 });
  }
  const scopeParam = parseScopeParam(searchParams);
  // EXIF facet filters (camera/lens/iso/aperture/focal) — shared with the
  // library + smart-collection query surfaces. Hash the raw values so the
  // cache key changes when any EXIF filter changes.
  const exifKey = EXIF_FILTER_KEYS.map((k) => `${k}=${searchParams.get(k) ?? ""}`).join("&");

  // Paging is sound only in plain/FTS mode. Both excluded modes are decided by
  // request params (not by how many rows come back) so the gate is
  // deterministic and safe to bake into the cache key.
  const semanticActive = semantic && q.length > 0;
  const paginated = !colorHex && !semanticActive;
  const cursorRaw = searchParams.get("cursor")?.trim() ?? "";
  let cursor: SearchCursor | null = null;
  if (cursorRaw) {
    if (!paginated) {
      return NextResponse.json(
        { error: "Cursor pagination is not supported with a color or semantic search" },
        { status: 400 },
      );
    }
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      logger.child({ component: "search" }).warn({ userId: user.id }, "rejected malformed search cursor");
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
  }

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
      exif: exifKey,
      // WITHOUT this, page 2 would serve page 1's cached body: same filters,
      // different window. Hash the DECODED cursor so two encodings of the same
      // position share an entry, and null in the non-pageable modes where the
      // cursor is rejected anyway.
      cursor: cursor ? `${cursor.b}|${cursor.i}` : null,
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
    // M12 / ADR 0014 — never surface absorbed Apple Live Photo companions.
    eq(schema.assets.motionCompanion, false),
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
  conditions.push(...exifFilterConditions(searchParams));

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

  // Tag filter via join. M10 / ADR 0013 — descendant-inclusive: a tag matches
  // its own assets AND every descendant tag's, via the materialized-path
  // prefix. `path LIKE '<target.path>%'` is self-inclusive (trailing slash).
  if (tagId) {
    const [target] = await db
      .select({ path: schema.tags.path })
      .from(schema.tags)
      .where(eq(schema.tags.id, tagId))
      .limit(1);
    if (!target?.path) return { assets: [], count: 0, cursor: null, truncated: false };
    const taggedAssets = await db
      .selectDistinct({ assetId: schema.assetTags.assetId })
      .from(schema.assetTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.assetTags.tagId))
      .where(sql`${schema.tags.path} LIKE ${target.path + "%"}`);
    assetIds = taggedAssets.map((r) => r.assetId);
    if (!assetIds.length) return { assets: [], count: 0, cursor: null, truncated: false };
    conditions.push(inArray(schema.assets.id, assetIds));
  }

  // Keyset predicate: strictly past the bound key, or on the bound key and past
  // its id. Mirrors /api/v1/assets, minus the direction switch (search has one
  // axis, createdAt ASC).
  //
  // The bound travels as TEXT end to end — never through `new Date(...)` —
  // because `createdAt` is a `timestamptz` with microsecond precision and a
  // JS Date only carries milliseconds. Comparing a Date-truncated bound
  // against the full-precision column made `gt` true for the very row the
  // cursor was built from (re-serving it on the next page) and made the `eq`
  // tiebreak below unreachable in practice, since the truncated bound could
  // essentially never equal the untruncated stored value. Casting the bound
  // text back to `timestamptz` in SQL keeps the comparison exact and mirrors
  // the `ORDER BY created_at ASC, id ASC` below exactly.
  if (cursor) {
    conditions.push(
      sql`(${schema.assets.createdAt} > ${cursor.b}::timestamptz OR (${schema.assets.createdAt} = ${cursor.b}::timestamptz AND ${schema.assets.id} > ${cursor.i}))`,
    );
  }

  const scanLimit = paginated ? PAGE_SIZE : UNPAGED_SCAN_LIMIT;
  let assets = await db
    .select({
      ...getTableColumns(schema.assets),
      // Full-precision text form of the same column, for building the next
      // cursor bound (see above) — never derived by re-formatting the JS
      // Date the driver hands back, which would re-truncate to milliseconds.
      // An explicit `to_char` mask (mirrors /api/v1/assets' sortKeyTextExpr)
      // rather than `::text`: the latter's output format tracks the session's
      // `DateStyle` GUC, so under a non-default DateStyle every emitted cursor
      // would stop matching TIMESTAMPTZ_TEXT_RE and page 2 would 400 forever.
      createdAtText: sql<string>`to_char(${schema.assets.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(schema.assets)
    .where(and(...conditions))
    .orderBy(asc(schema.assets.createdAt), asc(schema.assets.id))
    .limit(scanLimit);
  const scannedFullWindow = assets.length === scanLimit;

  // Color filter — applied in JS after the SQL pull because Postgres can't
  // efficiently compute Lab ΔE in pure SQL. This mode scans
  // UNPAGED_SCAN_LIMIT rows so the JS filter has headroom; output stays capped
  // at PAGE_SIZE. `resolvedColorRgb` was already validated at the request
  // boundary above, so an unparseable `color` never reaches here.
  if (colorHex && resolvedColorRgb) {
    const targetLab = rgbToLab(resolvedColorRgb[0], resolvedColorRgb[1], resolvedColorRgb[2]);
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

  // Cap the page and serialize via serializeAsset — handles ALL bigint columns
  // (phash AND seq). The previous hand-rolled map only converted phash, so the
  // unconverted `seq` bigint threw "Do not know how to serialize a BigInt" and
  // 500'd every search. Strip `createdAtText` first — it exists only to build
  // the cursor below and is not part of the published Asset shape.
  const page = assets.slice(0, PAGE_SIZE);
  const trimmed = page.map((a) => {
    const { createdAtText, ...rest } = a;
    void createdAtText;
    return serializeAsset(rest);
  });

  // A full page gets a cursor built from its last row; a short page is the end
  // of the result set. In the excluded modes there is no honest cursor, so say
  // the results were cut off instead.
  if (paginated) {
    const last = page[page.length - 1];
    return {
      assets: trimmed,
      count: trimmed.length,
      cursor:
        last && scannedFullWindow
          ? encodeCursor({ s: "created", b: last.createdAtText, i: last.id })
          : null,
      truncated: false,
    };
  }
  return {
    assets: trimmed,
    count: trimmed.length,
    cursor: null,
    truncated: scannedFullWindow || assets.length > PAGE_SIZE,
  };
  }
}
