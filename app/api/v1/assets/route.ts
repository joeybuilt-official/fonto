// SPDX-License-Identifier: MIT
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, asc, desc, gt, gte, isNull, isNotNull, lt, or, sql, SQL, like, ilike, inArray, exists } from "drizzle-orm";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { httpRequestDurationSeconds } from "@/lib/metrics";
import { createAssetRow, serializeAsset, assetGridColumns } from "@/lib/assets/createAssetRow";
import { isKind } from "@/lib/classify/kind";
import { detectMime } from "@/lib/mime";
import { recordAuditEvent, AuditAction } from "@/lib/audit";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";
import { parseScopeParam, scopeCond, isShootStage } from "@/lib/scope";
import { exifFilterConditions } from "@/lib/assets/exifFilters";

// Opaque keyset cursor: base64url(JSON({ s, b, i })) where
//   s = sort axis ("created" | "captured" | "name" | "rating" | "largest")
//   b = last row's sort-key value as text. For the time axes this is a
//       microsecond-precision UTC timestamp string (createdAt, or
//       COALESCE(capturedAt, createdAt) on the captured axis) — NEVER a JS
//       Date round trip, which truncates to millisecond precision and makes
//       the keyset predicate re-match the last row of the previous page.
//   i = last row's id (tie-break)
// Self-contained: decoding a cursor restores the sort axis too, so a caller
// can page purely by echoing `cursor` without re-sending `?sort=`. The
// discrete ?createdBefore/?capturedBefore/?idBefore params remain accepted
// for backward compatibility.
// Sort axes. "created" (ingestion order, default) and "captured" (EXIF capture
// time, falling back to ingestion) are DESC time axes and keep the legacy
// discrete ?createdBefore/?capturedBefore params. "name" (filename A→Z, ASC),
// "rating" (0..5 stars, DESC) and "largest" (byte size, DESC) sort globally
// server-side so the flat grid is correct across pages; those three page purely
// via the opaque `cursor` (no discrete legacy param).
type SortAxis = "created" | "captured" | "name" | "rating" | "largest";
const SORT_AXES: readonly SortAxis[] = [
  "created",
  "captured",
  "name",
  "rating",
  "largest",
];
function isSortAxis(v: unknown): v is SortAxis {
  return typeof v === "string" && (SORT_AXES as readonly string[]).includes(v);
}
// `i` (opaque-cursor tie-break, or the discrete `?idBefore=`) is bound into
// `gt/lt(schema.assets.id, idBeforeRaw)` against a uuid column — unvalidated,
// a non-UUID value surfaces as an unhandled Postgres "invalid input syntax
// for type uuid" (500) instead of a 400.
const idBeforeSchema = z.string().uuid();
type CursorPayload = { s: SortAxis; b: string; i: string };
function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (isSortAxis(p?.s) && typeof p?.b === "string" && typeof p?.i === "string") {
      return p as CursorPayload;
    }
  } catch {
    // fall through — malformed cursor is treated as "first page"
  }
  return null;
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });

  // Span every workspace the caller belongs to (shared + secondary), matching
  // /api/v1/search, /assets/[id], /assets/urls and /assets/export. Filtering
  // to workspaces[0] hid shared-workspace assets from the primary grid while
  // they still appeared in search and detail.
  const workspaceIds = workspaces.map((w) => w.id);
  const { searchParams } = request.nextUrl;
  const mimeFilter = searchParams.get("mime");
  const subtypeFilter = searchParams.get("subtype");
  const lifecycle = searchParams.get("lifecycle") ?? "active";
  const validLifecycles = ["active", "archivable", "archived", "trashed"];
  const lifecycleFilter = validLifecycles.includes(lifecycle) ? lifecycle : "active";

  // Phase 3.4 — favorites + ratings filter chips. Driven by query params:
  //   ?favorite=1       → only favorited assets
  //   ?ratingMin=4      → only assets rated >= 4 (1..5; clamped)
  // Anything else is ignored. Partial indexes (assets_workspace_favorite_idx
  // and assets_workspace_rating_idx) cover both predicates cheaply.
  const favoriteParam = searchParams.get("favorite");
  const onlyFavorites = favoriteParam === "1" || favoriteParam === "true";
  const ratingMinRaw = searchParams.get("ratingMin");
  const ratingMinParsed = ratingMinRaw == null ? NaN : Number.parseInt(ratingMinRaw, 10);
  const ratingMin =
    Number.isInteger(ratingMinParsed) && ratingMinParsed >= 1 && ratingMinParsed <= 5
      ? ratingMinParsed
      : null;

  // Phase 5.5 — manual stacks. Default behaviour: hide stack members other
  // than the primary so a 12-shot burst surfaces as one timeline tile. Pass
  // `?expandStacks=true` (or `=1`) to opt in to the historical "show every
  // asset" mode — used by tooling and the stack-detail view itself.
  const expandStacksParam = searchParams.get("expandStacks");
  const expandStacks =
    expandStacksParam === "true" || expandStacksParam === "1";

  // UX-3 — virtual-folder filter. Replaces the /folders page's "fetch
  // entire library + filter client-side" pattern. Two modes:
  //   ?directoryPath=/Photos/2024   → exact-match at that level only
  //   ?directoryPathPrefix=/Photos  → recursive: everything under /Photos
  // Empty / "/" treated as the root level (NULL directory_path).
  // The (workspace_id, directory_path) btree handles the equality path
  // index-driven; the prefix path uses `LIKE 'prefix/%'` which the same
  // index can serve as a range scan.
  const directoryPathRaw = searchParams.get("directoryPath");
  const directoryPathPrefixRaw = searchParams.get("directoryPathPrefix");
  const directoryPath =
    directoryPathRaw == null ? null : directoryPathRaw.trim();
  const directoryPathPrefix =
    directoryPathPrefixRaw == null ? null : directoryPathPrefixRaw.trim();

  const where: SQL[] = [
    inArray(schema.assets.workspaceId, workspaceIds),
    eq(schema.assets.lifecycleState, lifecycleFilter),
    // M12 / ADR 0014 — absorbed Apple Live Photo MOVs are hidden; their still
    // carries the clip. One tile = one moment.
    eq(schema.assets.motionCompanion, false),
  ];
  if (onlyFavorites) where.push(eq(schema.assets.isFavorite, true));
  if (ratingMin !== null) where.push(gte(schema.assets.rating, ratingMin));
  // ADR 0008 — scope default
  const __sc = scopeCond(parseScopeParam(searchParams));
  if (__sc) where.push(__sc);

  // ADR 0008 Phase 5 — shoot browser drill-in. `?shootId=` filters to one
  // shoot (or `?shootId=null` for assets scoped SHOOT but not yet filed).
  // `?shootStage=` further filters to a single stage bucket; "unstaged"
  // matches NULL stage. Both are advisory — they only narrow the asset
  // feed; the scope default still applies (the shoot browser pairs these
  // with `?scope=SHOOT`).
  const shootIdRaw = searchParams.get("shootId");
  if (shootIdRaw === "null") {
    where.push(isNull(schema.assets.shootId));
  } else if (shootIdRaw && shootIdRaw.trim() !== "") {
    where.push(eq(schema.assets.shootId, shootIdRaw.trim()));
  }
  const shootStageRaw = searchParams.get("shootStage");
  if (shootStageRaw === "unstaged") {
    where.push(isNull(schema.assets.shootStage));
  } else if (isShootStage(shootStageRaw)) {
    where.push(eq(schema.assets.shootStage, shootStageRaw));
  }

  // Timeline filter chips — coarse media type. Applied SERVER-side (unlike
  // the post-fetch `mime`/`subtype` filters below) so keyset pagination and
  // the /buckets scrubber counts stay exact. Mirrors the /stats buckets.
  const typeFilter = searchParams.get("type");
  if (typeFilter === "image") {
    where.push(like(schema.assets.mimeType, "image/%"));
  } else if (typeFilter === "video") {
    where.push(like(schema.assets.mimeType, "video/%"));
  } else if (typeFilter === "doc") {
    where.push(
      or(
        like(schema.assets.mimeType, "text/%"),
        eq(schema.assets.mimeType, "application/pdf"),
        like(schema.assets.mimeType, "application/vnd.openxmlformats-officedocument.%"),
        eq(schema.assets.mimeType, "application/msword")
      )!
    );
  }

  // Task 20 + Photos/Files split — KIND lens filter. Accepts a single kind
  // (moment | screenshot | graphics | document | video) OR a comma-separated
  // set (e.g. "moment,video" for the Photos "All" lens, "screenshot,graphics,
  // document" for Files "All"). Server-side so keyset pagination + the /buckets
  // scrubber counts stay exact. Backed by assets_workspace_kind_idx. Unknown
  // tokens are dropped; if none remain valid the filter is skipped.
  const kindFilter = searchParams.get("kind");
  if (kindFilter) {
    const kinds = kindFilter
      .split(",")
      .map((k) => k.trim())
      .filter((k) => isKind(k));
    if (kinds.length === 1) {
      where.push(eq(schema.assets.kind, kinds[0]));
    } else if (kinds.length > 1) {
      where.push(inArray(schema.assets.kind, kinds));
    }
  }

  // Photos/Files split — Inbox surface. `?unclassified=1` returns only assets
  // with no KIND yet (kind IS NULL). Drives the Inbox holding area above the
  // Photos/Files segmented control; it self-hides once the classifier drains
  // NULL to zero. Mutually exclusive with ?kind= in practice (the Inbox never
  // sends a kind lens).
  const unclassifiedParam = searchParams.get("unclassified");
  if (unclassifiedParam === "1" || unclassifiedParam === "true") {
    where.push(isNull(schema.assets.kind));
  }

  // Photos/Files split — Files surface server-side search. `?q=` matches
  // filename, OCR text, or source-app (case-insensitive substring). Pushed
  // into the DB WHERE (unlike the legacy client post-fetch q) so the Files
  // list paginates correctly over the full result set. The Photos surface
  // does not use this path — it relies on visual/person/place search elsewhere.
  const qRaw = searchParams.get("q");
  const q = qRaw == null ? "" : qRaw.trim();
  if (q !== "") {
    const pat = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    // OCR text is the heavy arm: a leading-wildcard ILIKE ('%q%') over each
    // row's (potentially multi-KB) ocr_text forces a sequential scan of the
    // whole workspace partition on every keystroke. Route that arm through the
    // SAME tsvector path /api/v1/search uses — `to_tsvector('english',
    // coalesce(ocr_text,'')) @@ plainto_tsquery(...)` — which is backed by the
    // existing GIN index `assets_ocr_text_fts_idx` (migration 0002). This flips
    // OCR matching from substring to token/stem semantics, matching the app's
    // canonical search behaviour. filename + source stay substring-ILIKE (short
    // columns; no tsvector/trgm index exists for them — see risks: a pg_trgm
    // GIN index on lower(filename)/lower(source) is the real fix to make the
    // whole OR fully index-driven).
    where.push(
      or(
        ilike(schema.assets.filename, pat),
        sql`to_tsvector('english', coalesce(${schema.assets.ocrText}, '')) @@ plainto_tsquery('english', ${q})`,
        ilike(schema.assets.source, pat)
      )!
    );
  }

  // Capture-date segregation for the dated timeline. The month grid only wants
  // assets with a real capture date; the "Undated" section wants only those
  // without one. `?capturedState=dated|undated` splits the two so neither the
  // per-month windowed fetch nor the undated fetch leaks into the other.
  const capturedState = searchParams.get("capturedState");
  if (capturedState === "dated") {
    where.push(isNotNull(schema.assets.capturedAt));
  } else if (capturedState === "undated") {
    where.push(isNull(schema.assets.capturedAt));
  }

  // Date-range filter over the captured timeline (COALESCE(capturedAt,
  // createdAt)). `?dateFrom=<iso>` (inclusive lower) and `?dateTo=<iso>`
  // (inclusive upper) narrow the flat grid SERVER-side (unlike a post-fetch JS
  // trim) so keyset pagination + the /buckets counts stay exact. Either bound
  // is optional; a malformed value is ignored. Independent of the sort axis so
  // a name/rating/largest sort can still be scoped to a date window.
  const dateFromRaw = searchParams.get("dateFrom");
  const dateToRaw = searchParams.get("dateTo");
  const capturedCoalesce = sql`COALESCE(${schema.assets.capturedAt}, ${schema.assets.createdAt})`;
  if (dateFromRaw && !Number.isNaN(Date.parse(dateFromRaw))) {
    where.push(
      sql`${capturedCoalesce} >= ${new Date(dateFromRaw).toISOString()}::timestamptz`
    );
  }
  if (dateToRaw && !Number.isNaN(Date.parse(dateToRaw))) {
    where.push(
      sql`${capturedCoalesce} <= ${new Date(dateToRaw).toISOString()}::timestamptz`
    );
  }

  // Person-group filter: show only assets where at least one face belongs to
  // a person in the requested group.
  const groupIdParam = searchParams.get("group_id");
  if (groupIdParam) {
    where.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.faceInstances)
          .innerJoin(
            schema.personGroupMembers,
            eq(schema.personGroupMembers.personId, schema.faceInstances.personId)
          )
          .where(
            and(
              eq(schema.faceInstances.assetId, schema.assets.id),
              eq(schema.personGroupMembers.groupId, groupIdParam)
            )
          )
      )
    );
  }

  // Explore → Places: geo-tagged assets only. `?hasGeo=1` keeps rows where
  // both EXIF coordinates resolved. Served index-driven by
  // `assets_lat_lon_idx`. Mirrors the web Explore "Places" tile probe.
  const hasGeoParam = searchParams.get("hasGeo");
  if (hasGeoParam === "1" || hasGeoParam === "true") {
    where.push(isNotNull(schema.assets.latitude));
    where.push(isNotNull(schema.assets.longitude));
  }

  // Explore → Places drill-in: `?place=<reverse-geocoded name>` filters to one
  // place group. Backed by the place_name column the worker populates from EXIF.
  const placeParam = searchParams.get("place");
  if (placeParam != null && placeParam.trim() !== "") {
    where.push(eq(schema.assets.placeName, placeParam.trim()));
  }
  // mime-prefix + classification chips. Pushed into SQL (mirrors the /buckets
  // route) so keyset pagination is exact — a post-fetch JS filter dropped rows
  // AFTER the page was cut, silently shrinking pages and desyncing the cursor.
  //   ?mime=image/     → like(mime_type, 'image/%')  (starts-with)
  //   ?subtype=<class> → classification = <class>
  if (mimeFilter) where.push(like(schema.assets.mimeType, `${mimeFilter}%`));
  if (subtypeFilter) where.push(eq(schema.assets.classification, subtypeFilter));

  // EXIF facet filters (camera/lens/iso/aperture/focal) — shared parser so the
  // library grid, smart collections and q-search stay in lockstep.
  where.push(...exifFilterConditions(searchParams));
  if (directoryPath != null) {
    if (directoryPath === "" || directoryPath === "/") {
      where.push(isNull(schema.assets.directoryPath));
    } else {
      where.push(eq(schema.assets.directoryPath, directoryPath));
    }
  } else if (directoryPathPrefix != null && directoryPathPrefix !== "") {
    // Recursive: anything under the prefix. Trailing slash is normalised
    // off the request value so callers can pass either `/Photos` or
    // `/Photos/`. The LIKE pattern uses `%` to match descendants.
    const normalised = directoryPathPrefix.replace(/\/+$/, "");
    where.push(like(schema.assets.directoryPath, `${normalised}/%`));
  }
  if (!expandStacks) {
    // Show standalone assets OR the primary of each stack the asset
    // belongs to. Correlated subquery keeps everything index-driven via
    // `stacks_primary_asset_id_idx` + `assets_workspace_stack_idx`.
    where.push(
      or(
        isNull(schema.assets.stackId),
        sql`${schema.assets.id} = (SELECT ${schema.stacks.primaryAssetId} FROM ${schema.stacks} WHERE ${schema.stacks.id} = ${schema.assets.stackId})`
      )!
    );
  }

  // `?limit=N` row cap. ALWAYS bounded: an omitted/invalid limit defaults to
  // DEFAULT_LIMIT (200) and any value is clamped to MAX_LIMIT (1000). Before
  // this, an absent limit meant NO `.limit()` at all — GET /assets streamed
  // the ENTIRE workspace (tens of thousands of rows) in one response. The
  // query below always applies `.limit(limit)` now, and keyset pagination
  // (cursor / *Before params) walks the rest of the library one page at a time.
  const DEFAULT_LIMIT = 200;
  const MAX_LIMIT = 1000;
  const limitRaw = searchParams.get("limit");
  const limitParsed = limitRaw == null ? NaN : Number.parseInt(limitRaw, 10);
  const limit =
    Number.isInteger(limitParsed) && limitParsed > 0
      ? Math.min(limitParsed, MAX_LIMIT)
      : DEFAULT_LIMIT;

  // Phase 6.2 — keyset pagination for the mobile grid (and any other
  // client that wants stable "load more" semantics). Caller passes:
  //   ?createdBefore=<iso>         — required to engage paging
  //   ?idBefore=<uuid>             — tie-break when two rows share createdAt
  // Returns rows strictly older than the cursor. Same DESC ordering as
  // the unpaged path so the first page + a paged second page concatenate
  // cleanly. Omitting both keeps the original head-of-list behaviour.
  // Sort axis. Default "created" (ingestion order — preserves legacy
  // behaviour and the mobile grid). "captured" orders by when the photo was
  // actually taken (EXIF capture time, falling back to ingestion when absent)
  // — the Photos-style timeline. Backed by assets_workspace_captured_at_idx.
  // Opaque cursor (preferred) decodes to { s, b, i } and, when present,
  // supplies the sort axis + keyset position. Absent → fall back to ?sort= and
  // the discrete ?createdBefore/?capturedBefore/?idBefore params.
  const cursorRaw = searchParams.get("cursor");
  const decodedCursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  const sortParam = searchParams.get("sort");
  const sortAxis: SortAxis = decodedCursor
    ? decodedCursor.s
    : isSortAxis(sortParam)
      ? sortParam
      : "created";
  // ASC for name (A→Z); DESC for the time / rating / size axes.
  const sortDir: "asc" | "desc" = sortAxis === "name" ? "asc" : "desc";
  const sortExpr =
    sortAxis === "captured"
      ? sql`COALESCE(${schema.assets.capturedAt}, ${schema.assets.createdAt})`
      : sortAxis === "name"
        ? sql`LOWER(${schema.assets.filename})`
        : sortAxis === "rating"
          ? sql`${schema.assets.rating}`
          : sortAxis === "largest"
            ? sql`${schema.assets.sizeBytes}`
            : sql`${schema.assets.createdAt}`;

  // Phase 6.2 — keyset pagination. The cursor param name tracks the sort axis:
  //   created  → ?createdBefore=<iso>   captured → ?capturedBefore=<iso>
  // plus ?idBefore=<uuid> as the tie-break. Returns rows strictly older than
  // the cursor under the same ordering, so pages concatenate cleanly.
  const idBeforeRaw = decodedCursor?.i ?? searchParams.get("idBefore");
  if (idBeforeRaw != null && !idBeforeSchema.safeParse(idBeforeRaw).success) {
    return NextResponse.json({ error: "Invalid idBefore" }, { status: 400 });
  }
  // Where the keyset "before" value comes from. The opaque cursor carries it
  // for every axis; the discrete ?createdBefore/?capturedBefore params stay
  // accepted for the two legacy time axes. name/rating/largest page only via
  // the opaque cursor.
  const beforeRaw =
    decodedCursor?.b ??
    (sortAxis === "created"
      ? searchParams.get("createdBefore")
      : sortAxis === "captured"
        ? searchParams.get("capturedBefore")
        : null);
  // Turn the raw "before" string into a typed, cast SQL bind for the active
  // axis (or null when missing/invalid). timestamptz for the time axes, int for
  // rating, bigint for size, lowercased text for the filename. postgres-js
  // can't infer the bind type when the LHS is an expression (COALESCE / LOWER),
  // so every bind carries an explicit cast.
  const sortBound: SQL | null = (() => {
    if (beforeRaw == null) return null;
    switch (sortAxis) {
      case "created":
      case "captured": {
        // Bind the raw cursor/param text as-is — reconstructing through
        // `new Date(...).toISOString()` rounds to millisecond precision and
        // makes the strict `<`/`>` comparison re-match the last row of the
        // previous page (createdAt/capturedAt are timestamp(6), i.e.
        // microsecond-precision, in Postgres). `Date.parse` here is only a
        // format sanity check; Postgres parses the text directly.
        if (Number.isNaN(Date.parse(beforeRaw))) return null;
        return sql`${beforeRaw}::timestamptz`;
      }
      case "rating": {
        const n = Number.parseInt(beforeRaw, 10);
        return Number.isInteger(n) ? sql`${n}::int` : null;
      }
      case "largest":
        return /^\d+$/.test(beforeRaw) ? sql`${beforeRaw}::bigint` : null;
      case "name":
        return sql`${beforeRaw.toLowerCase()}`;
    }
  })();
  if (sortBound) {
    // Direction-aware keyset: strict comparison on the sort key, id as the
    // tie-break when two rows share the same key. ASC for name, DESC otherwise.
    const strictCmp =
      sortDir === "asc"
        ? sql`${sortExpr} > ${sortBound}`
        : sql`${sortExpr} < ${sortBound}`;
    if (idBeforeRaw) {
      const idTie =
        sortDir === "asc"
          ? gt(schema.assets.id, idBeforeRaw)
          : lt(schema.assets.id, idBeforeRaw);
      where.push(or(strictCmp, and(sql`${sortExpr} = ${sortBound}`, idTie))!);
    } else {
      where.push(strictCmp);
    }
  }

  // The sort key emitted into the next cursor, projected in SQL as text at
  // full column precision — never round-tripped through a JS Date, which
  // node-postgres parses to millisecond precision and would silently drop
  // the microsecond tail that timestamp(6) columns (createdAt/capturedAt)
  // actually store, re-matching the last row of the page on the next fetch.
  const sortKeyTextExpr =
    sortAxis === "captured"
      ? sql<string>`to_char(COALESCE(${schema.assets.capturedAt}, ${schema.assets.createdAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : sortAxis === "created"
        ? sql<string>`to_char(${schema.assets.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        : sortAxis === "name"
          ? sql<string>`LOWER(${schema.assets.filename})`
          : sortAxis === "rating"
            ? sql<string>`${schema.assets.rating}::text`
            : sql<string>`${schema.assets.sizeBytes}::text`;

  // UX-3 / Phase 5.5 — surface the stack member count alongside each asset so
  // PhotoCard can render a "Stack of N" badge without a per-tile round trip.
  // Replaces the former per-row correlated `SELECT COUNT(*)` (which ran once
  // per stacked row of the page) with ONE pre-aggregated pass over the
  // workspace's stacks, LEFT JOINed by stack_id. Results are identical: the
  // aggregate counts the FULL stack (independent of this page's filters /
  // stack-collapse / keyset window), exactly as the old subquery did by
  // ignoring the outer WHERE. Standalone assets (stack_id NULL) never match the
  // join → stackMemberCount is NULL, same as the old CASE-WHEN-NULL. stack_ids
  // are workspace-scoped, so filtering the aggregate by workspace changes no
  // count while keeping it index-driven (assets_workspace_stack_idx).
  const stackCounts = db
    .select({
      stackId: schema.assets.stackId,
      memberCount: sql<number>`COUNT(*)::int`.as("member_count"),
    })
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.workspaceId, workspaceIds),
        isNotNull(schema.assets.stackId)
      )
    )
    .groupBy(schema.assets.stackId)
    .as("stack_counts");

  // LIST projection: every asset column except the heavy clip_vec / OCR /
  // extracted-text payloads (see assetGridColumns). All mime/subtype/etc.
  // filtering now lives in the SQL WHERE above, so the page returned is exact
  // — no post-fetch trimming — and the keyset cursor stays consistent. The
  // stackCounts LEFT JOIN is 1:1 (grouped by stack_id) so it never fans out the
  // page or perturbs the ORDER BY / keyset.
  const rows = await db
    .select({
      asset: assetGridColumns(),
      stackMemberCount: stackCounts.memberCount,
      sortKeyRaw: sortKeyTextExpr,
    })
    .from(schema.assets)
    .leftJoin(stackCounts, eq(stackCounts.stackId, schema.assets.stackId))
    .where(and(...where))
    .orderBy(
      sortDir === "asc" ? sql`${sortExpr} ASC` : sql`${sortExpr} DESC`,
      sortDir === "asc" ? asc(schema.assets.id) : desc(schema.assets.id)
    )
    .limit(limit);

  // Cursor for the next page: derived from the last row of a FULL page. A
  // short page (rows.length < limit) means we've reached the end → null
  // cursor, no more pages. Emitted both as the opaque `cursor` string
  // (preferred) and the legacy `nextCursor` object (web library page + mobile
  // client parse this shape).
  const lastRow = rows[rows.length - 1];
  let nextCursor: Record<string, string> | null = null;
  let cursor: string | null = null;
  if (lastRow && rows.length === limit) {
    const a = lastRow.asset;
    const b = lastRow.sortKeyRaw;
    cursor = encodeCursor({ s: sortAxis, b, i: a.id });
    // The legacy discrete-param `nextCursor` object only exists for the two
    // time axes; name/rating/largest callers page via the opaque `cursor`.
    nextCursor =
      sortAxis === "captured"
        ? { capturedBefore: b, idBefore: a.id }
        : sortAxis === "created"
          ? { createdBefore: b, idBefore: a.id }
          : null;
  }

  return NextResponse.json({
    assets: rows.map((r) => ({
      ...serializeAsset(r.asset),
      stackMemberCount: r.stackMemberCount,
    })),
    cursor,
    nextCursor,
  });
}

/**
 * @deprecated Phase 1.2 (parity): use the two-step direct-to-R2 flow.
 *   1. POST /api/v1/assets/init                  → presigned PUT URL
 *   2. PUT  <presignedUrl>                       → file goes straight to R2
 *   3. POST /api/v1/assets/:uploadId/complete    → finalizes the asset row
 *
 * This handler buffers the whole request body into Node memory before
 * pushing it to R2; it stays only for pre-migration clients. The response
 * carries `Deprecation: true`. TODO: remove once the web client is fully
 * on the direct path (gated by NEXT_PUBLIC_DIRECT_UPLOAD).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const endTimer = httpRequestDurationSeconds.startTimer({
    method: "POST",
    route: "/api/v1/assets",
  });
  let response: NextResponse;
  try {
    response = await handlePost(request);
  } catch (err) {
    endTimer({ status_code: "500" });
    throw err;
  }
  response.headers.set("Deprecation", "true");
  response.headers.set("Link", '</api/v1/assets/init>; rel="successor-version"');
  endTimer({ status_code: String(response.status) });
  return response;
}

async function handlePost(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }
  const workspaceId = workspaces[0].id;

  // Phase 7b — upload relaxed editor → contributor. Contributors can
  // upload but can't delete or share — see WorkspaceRole ladder in
  // lib/authz.ts.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "contributor");
  if (!gate.ok) return gate.response;

  // Idempotency: check X-Upload-Id header.
  const uploadId = request.headers.get("X-Upload-Id");
  if (uploadId) {
    const [existingSession] = await db
      .select()
      .from(schema.uploadSessions)
      .where(
        and(
          eq(schema.uploadSessions.uploadId, uploadId),
          eq(schema.uploadSessions.userId, user.id)
        )
      )
      .limit(1);

    if (existingSession?.state === "completed" && existingSession.assetId) {
      const [existingAsset] = await db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, existingSession.assetId))
        .limit(1);
      if (existingAsset) {
        return NextResponse.json({ asset: serializeAsset(existingAsset) }, { status: 200 });
      }
    }
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const source = (formData.get("source") as string | null) ?? "web-upload";

  // Legacy multipart cap stays at 50 MB — direct-to-R2 path raises this to
  // MAX_UPLOAD_BYTES (default 500 MB) since that flow streams.
  const LEGACY_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  if (file.size > LEGACY_MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "File too large. Maximum upload size is 50 MB. Use /api/v1/assets/init for larger uploads." },
      { status: 413 }
    );
  }

  // Phase 9.1 — quota preflight (same check as init route).
  const [ws] = await db
    .select({ quotaBytes: schema.workspaces.quotaBytes, usageBytes: schema.workspaces.usageBytes })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (ws?.quotaBytes != null) {
    const wouldUse = (ws.usageBytes ?? 0) + file.size;
    if (wouldUse > ws.quotaBytes) {
      return NextResponse.json(
        { error: "Storage quota exceeded", quotaBytes: ws.quotaBytes, usageBytes: ws.usageBytes ?? 0 },
        { status: 413 }
      );
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Resolve the canonical mime. Browser-set `file.type` is often blank or
  // `application/octet-stream` for HEIC and camera-RAW uploads — `detectMime`
  // sniffs the magic bytes (and falls back to filename extension for RAW)
  // so downstream pHash/EXIF/decoder modules can route correctly. The shared
  // `createAssetRow` helper handles dedup + perceptual + EXIF + queue enqueue.
  const { mimeType } = await detectMime(buffer, file.type, file.name);

  // Open upload session for idempotency tracking.
  let sessionId: string | null = null;
  if (uploadId) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [session] = await db
      .insert(schema.uploadSessions)
      .values({ uploadId, userId: user.id, workspaceId, expiresAt })
      .onConflictDoNothing()
      .returning({ id: schema.uploadSessions.id });
    sessionId = session?.id ?? null;
  }

  // Phase 3.5 — optional virtual folder path. Clients pass the source
  // directory via `X-Fonto-Path` (header chosen over form field so curl
  // examples and the existing FormData path don't need to be reshuffled).
  const directoryPath = normalizeDirectoryPath(
    request.headers.get("X-Fonto-Path"),
    { filename: file.name }
  );

  const result = await createAssetRow({
    workspaceId,
    userId: user.id,
    userEmail: user.email ?? null,
    filename: file.name,
    mimeType,
    sizeBytes: file.size,
    buffer,
    source,
    directoryPath,
  });

  if (result.deduplicated) {
    return NextResponse.json(
      { asset: serializeAsset(result.asset), deduplicated: true },
      { status: 200 }
    );
  }

  // The legacy path uploads to R2 AFTER the row exists. createAssetRow inserts
  // the row as `synced` (so the direct-to-R2 path is correct); we override it
  // back to `syncing` while we PUT the buffer.
  const asset = result.asset;
  await db
    .update(schema.assets)
    .set({ syncState: "syncing" })
    .where(eq(schema.assets.id, asset.id));

  const key = assetStorageKey(workspaceId, asset.id, file.name);
  try {
    await storage().put(key, buffer, {
      contentType: mimeType,
      contentLength: file.size,
    });

    await db
      .update(schema.assets)
      .set({ syncState: "synced" })
      .where(eq(schema.assets.id, asset.id));

    // Phase 9.1 — increment usage (fire-and-forget; reconcile corrects drift).
    void db
      .update(schema.workspaces)
      .set({ usageBytes: sql`${schema.workspaces.usageBytes} + ${file.size}` })
      .where(eq(schema.workspaces.id, workspaceId));

    if (sessionId) {
      await db
        .update(schema.uploadSessions)
        .set({ state: "completed", assetId: asset.id })
        .where(eq(schema.uploadSessions.id, sessionId));
    }

    // Phase 3.2 — audit. Fire-and-forget; never blocks the upload response.
    void recordAuditEvent({
      workspaceId,
      userId: user.id,
      action: AuditAction.AssetUpload,
      targetType: "asset",
      targetId: asset.id,
      metadata: {
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
        deduplicated: false,
        legacyMultipart: true,
      },
      request,
    });

    return NextResponse.json(
      {
        asset: serializeAsset({ ...asset, syncState: "synced" }),
        ...(result.possibleDuplicate ? { possibleDuplicate: result.possibleDuplicate } : {}),
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[fonto] R2 upload failed:", err);
    await db
      .update(schema.assets)
      .set({ syncState: "error" })
      .where(eq(schema.assets.id, asset.id));
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
