// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import { httpRequestDurationSeconds } from "@/lib/metrics";
import { createAssetRow, serializeAsset } from "@/lib/assets/createAssetRow";
import { detectMime } from "@/lib/mime";

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

  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, lifecycleFilter)
      )
    )
    .orderBy(desc(schema.assets.createdAt));

  const filtered = rows
    .filter((a) => !mimeFilter || a.mimeType.startsWith(mimeFilter))
    .filter((a) => !subtypeFilter || a.classification === subtypeFilter);

  return NextResponse.json({ assets: filtered.map(serializeAsset) });
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

  // Phase 3.1 — editor or higher required to upload.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
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

  const result = await createAssetRow({
    workspaceId,
    userId: user.id,
    userEmail: user.email ?? null,
    filename: file.name,
    mimeType,
    sizeBytes: file.size,
    buffer,
    source,
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

    if (sessionId) {
      await db
        .update(schema.uploadSessions)
        .set({ state: "completed", assetId: asset.id })
        .where(eq(schema.uploadSessions.id, sessionId));
    }

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
