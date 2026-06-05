// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, desc, gte, isNull, isNotNull, lt, or, sql, SQL, like } from "drizzle-orm";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import { httpRequestDurationSeconds } from "@/lib/metrics";
import { createAssetRow, serializeAsset } from "@/lib/assets/createAssetRow";
import { detectMime } from "@/lib/mime";
import { recordAuditEvent, AuditAction } from "@/lib/audit";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });

  const workspaceId = workspaces[0].id;
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
    eq(schema.assets.workspaceId, workspaceId),
    eq(schema.assets.lifecycleState, lifecycleFilter),
  ];
  if (onlyFavorites) where.push(eq(schema.assets.isFavorite, true));
  if (ratingMin !== null) where.push(gte(schema.assets.rating, ratingMin));

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

  // UX-3 — `?limit=N` row cap. The dashboard's "recent uploads" row used
  // to pull the entire workspace then `.slice(0, 8)` client-side (audit
  // bug §UX-4); now it can ask for exactly what it needs. Mime / subtype
  // filtering is post-fetch so the cap is approximate when those are set,
  // but for the "show 8 newest of everything" pattern it's exact.
  const limitRaw = searchParams.get("limit");
  const limitParsed = limitRaw == null ? NaN : Number.parseInt(limitRaw, 10);
  const limit =
    Number.isInteger(limitParsed) && limitParsed > 0 && limitParsed <= 1000
      ? limitParsed
      : null;

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
  const sortAxis = searchParams.get("sort") === "captured" ? "captured" : "created";
  const sortExpr =
    sortAxis === "captured"
      ? sql`COALESCE(${schema.assets.capturedAt}, ${schema.assets.createdAt})`
      : sql`${schema.assets.createdAt}`;

  // Phase 6.2 — keyset pagination. The cursor param name tracks the sort axis:
  //   created  → ?createdBefore=<iso>   captured → ?capturedBefore=<iso>
  // plus ?idBefore=<uuid> as the tie-break. Returns rows strictly older than
  // the cursor under the same ordering, so pages concatenate cleanly.
  const idBeforeRaw = searchParams.get("idBefore");
  const beforeRaw = searchParams.get(
    sortAxis === "captured" ? "capturedBefore" : "createdBefore"
  );
  // Keep the cursor as the original ISO string and cast to timestamptz in
  // SQL. postgres-js can't infer the bind type for a Date when the LHS is a
  // COALESCE expression (the `captured` sort path), so binding a string + an
  // explicit ::timestamptz cast keeps both sort axes happy.
  const before =
    beforeRaw && !Number.isNaN(Date.parse(beforeRaw))
      ? new Date(beforeRaw).toISOString()
      : null;
  if (before) {
    if (idBeforeRaw) {
      where.push(
        or(
          sql`${sortExpr} < ${before}::timestamptz`,
          and(
            sql`${sortExpr} = ${before}::timestamptz`,
            lt(schema.assets.id, idBeforeRaw)
          )
        )!
      );
    } else {
      where.push(sql`${sortExpr} < ${before}::timestamptz`);
    }
  }

  // UX-3 / Phase 5.5 — surface the stack member count alongside each
  // asset so PhotoCard can render a "Stack of N" badge without a per-tile
  // round trip. Correlated subquery returns NULL for standalone assets
  // (cheap: indexed by `assets_workspace_stack_idx`). The serialized
  // shape carries it under `stackMemberCount`.
  const stackMemberCountSql = sql<number | null>`(
    CASE WHEN ${schema.assets.stackId} IS NULL THEN NULL
    ELSE (SELECT COUNT(*)::int FROM ${schema.assets} a2
          WHERE a2.stack_id = ${schema.assets.stackId})
    END
  )`.as("stack_member_count");

  const query = db
    .select({
      asset: schema.assets,
      stackMemberCount: stackMemberCountSql,
    })
    .from(schema.assets)
    .where(and(...where))
    .orderBy(sql`${sortExpr} DESC`, desc(schema.assets.id));
  const rows = limit != null ? await query.limit(limit) : await query;

  const filtered = rows
    .filter((r) => !mimeFilter || r.asset.mimeType.startsWith(mimeFilter))
    .filter((r) => !subtypeFilter || r.asset.classification === subtypeFilter);

  // Cursor for the *next* page: derived from the last *pre-filter* row
  // (post-filter mime/subtype is approximate per the existing comment;
  // using `filtered` here would skip server-side rows the next page
  // still needs to walk past). Null when the page is empty or unbounded.
  const lastRow = rows[rows.length - 1];
  let nextCursor: Record<string, string> | null = null;
  if (limit != null && lastRow && rows.length === limit) {
    if (sortAxis === "captured") {
      const c = lastRow.asset.capturedAt ?? lastRow.asset.createdAt;
      nextCursor = { capturedBefore: c.toISOString(), idBefore: lastRow.asset.id };
    } else {
      nextCursor = {
        createdBefore: lastRow.asset.createdAt.toISOString(),
        idBefore: lastRow.asset.id,
      };
    }
  }

  return NextResponse.json({
    assets: filtered.map((r) => ({
      ...serializeAsset(r.asset),
      stackMemberCount: r.stackMemberCount,
    })),
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
  const bucket = process.env.R2_BUCKET!;
  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ContentLength: file.size,
      })
    );

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
