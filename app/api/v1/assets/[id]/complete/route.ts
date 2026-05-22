// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.2 (parity): step 2 of the two-step direct-to-R2 upload.
//
// The client has already PUT the file body to R2 via the presigned URL from
// /api/v1/assets/init. Now we finalize the asset:
//
//  1. Look up the `asset_uploads` row (must belong to this user, be pending,
//     not expired).
//  2. HEAD the R2 object to confirm it exists and the size matches.
//  3. Compute the server-side SHA-256 by STREAMING the object through
//     crypto.createHash — never buffer-then-hash. (Skippable via env
//     SKIP_SERVER_CHECKSUM=true when the client supplied clientChecksum.)
//  4. Hand the buffer (re-read once for EXIF) to the shared createAssetRow
//     helper, which does dedup + EXIF + pHash + insert + enqueue.
//  5. Mark the upload row completed with `assetId` set.
//  6. Return the same `{ asset, possibleDuplicate? }` shape the legacy POST
//     returns so the client path is symmetric.
//
// The `[id]` route segment is the `uploadId` (UUID issued by /init), NOT the
// final asset id — the final asset id lives on the row only after complete.

import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  HeadObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { getAuthUser } from "@/lib/auth/server";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { getS3Client } from "@/lib/r2";
import { createAssetRow, serializeAsset } from "@/lib/assets/createAssetRow";

const CompleteRequestSchema = z.object({
  // Optional, but accepted for symmetry with /init's response. We mainly
  // identify the upload via the `[id]` path segment.
  uploadId: z.string().uuid().optional(),
  /** Optional client-recorded source label. */
  source: z.string().max(64).optional(),
});

function skipServerChecksum(): boolean {
  const v = (process.env.SKIP_SERVER_CHECKSUM ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Stream an S3 GetObjectCommand body through a SHA-256 hasher without ever
 * holding the full object in memory. Returns the hex digest.
 */
async function streamSha256(body: GetObjectCommandOutput["Body"]): Promise<string> {
  if (!body) throw new Error("R2 GetObject returned empty body");
  const hash = createHash("sha256");

  // The AWS SDK v3 returns a Node Readable, a Web ReadableStream, or a Blob
  // depending on the runtime. We treat each.
  if (body instanceof Readable) {
    for await (const chunk of body) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }
  if (typeof (body as { getReader?: unknown }).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) hash.update(Buffer.from(value));
    }
    return hash.digest("hex");
  }
  // Fallback for Blob-like bodies.
  if (typeof (body as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === "function") {
    const ab = await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    hash.update(Buffer.from(ab));
    return hash.digest("hex");
  }
  throw new Error("Unsupported R2 GetObject body type");
}

/** Buffer an S3 GetObject body fully. Used only when we need bytes for EXIF. */
async function bufferS3Body(body: GetObjectCommandOutput["Body"]): Promise<Buffer> {
  if (!body) throw new Error("R2 GetObject returned empty body");
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  if (typeof (body as { getReader?: unknown }).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (typeof (body as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === "function") {
    const ab = await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(ab);
  }
  throw new Error("Unsupported R2 GetObject body type");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: uploadIdParam } = await params;

  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof CompleteRequestSchema> = {};
  // Body is optional — /complete can be called with no JSON.
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = CompleteRequestSchema.parse(JSON.parse(text));
    }
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid request body", details: err instanceof z.ZodError ? err.flatten() : undefined },
      { status: 400 }
    );
  }

  const uploadId = body.uploadId ?? uploadIdParam;
  if (uploadId !== uploadIdParam) {
    return NextResponse.json(
      { error: "uploadId in body does not match URL" },
      { status: 400 }
    );
  }

  // Look up the upload row scoped to this user.
  const [upload] = await db
    .select()
    .from(schema.assetUploads)
    .where(
      and(
        eq(schema.assetUploads.id, uploadId),
        eq(schema.assetUploads.userId, user.id)
      )
    )
    .limit(1);

  if (!upload) {
    return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  }
  if (upload.state === "completed" && upload.assetId) {
    // Idempotent replay: return the same asset.
    const [existingAsset] = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, upload.assetId))
      .limit(1);
    if (existingAsset) {
      return NextResponse.json({ asset: serializeAsset(existingAsset) }, { status: 200 });
    }
  }
  if (upload.state === "aborted") {
    return NextResponse.json({ error: "Upload was aborted" }, { status: 410 });
  }
  if (upload.presignedExpiresAt.getTime() < Date.now() - 60_000) {
    // Allow a 60s grace window past expiry — R2 PUTs racing the clock
    // shouldn't fail to finalize.
    await db
      .update(schema.assetUploads)
      .set({ state: "aborted", updatedAt: new Date() })
      .where(eq(schema.assetUploads.id, uploadId));
    return NextResponse.json({ error: "Upload URL expired" }, { status: 410 });
  }

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    return NextResponse.json({ error: "R2_BUCKET not configured" }, { status: 500 });
  }
  const s3 = getS3Client();

  // 1) HEAD: confirm the object exists and the size matches what /init was told.
  let headSize: number | null = null;
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: upload.storageKey })
    );
    headSize = typeof head.ContentLength === "number" ? head.ContentLength : null;
  } catch (err) {
    console.error("[fonto] R2 HEAD failed:", err);
    return NextResponse.json({ error: "Upload object not found in storage" }, { status: 404 });
  }
  if (headSize == null || headSize !== upload.sizeBytes) {
    return NextResponse.json(
      { error: "Uploaded object size does not match init declaration", expected: upload.sizeBytes, actual: headSize },
      { status: 409 }
    );
  }

  // 2) Compute SHA-256. Stream the body unless the client provided a checksum
  //    AND SKIP_SERVER_CHECKSUM is enabled.
  let sha256: string;
  const trustClientChecksum = skipServerChecksum() && upload.clientChecksum;
  if (trustClientChecksum && upload.clientChecksum) {
    sha256 = upload.clientChecksum.toLowerCase();
  } else {
    try {
      const get = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: upload.storageKey })
      );
      sha256 = await streamSha256(get.Body);
    } catch (err) {
      console.error("[fonto] streaming sha256 failed:", err);
      return NextResponse.json({ error: "Failed to verify upload" }, { status: 500 });
    }
    // If client supplied a checksum, refuse a mismatch — that's a data
    // integrity error worth surfacing rather than silently dropping.
    if (upload.clientChecksum && upload.clientChecksum.toLowerCase() !== sha256) {
      return NextResponse.json(
        { error: "Client SHA-256 does not match server-computed SHA-256" },
        { status: 409 }
      );
    }
  }

  // 3) EXIF needs the bytes in memory. Second GET; same cap (~50 MB images)
  //    that the legacy multipart path already buffers — for video/RAW we
  //    accept that this pass is a no-op since extractExif returns nulls.
  let buffer: Buffer;
  try {
    const get = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: upload.storageKey })
    );
    buffer = await bufferS3Body(get.Body);
  } catch (err) {
    console.error("[fonto] R2 GET for EXIF failed:", err);
    return NextResponse.json({ error: "Failed to read upload" }, { status: 500 });
  }

  // 4) Hand off to the shared row-build helper. The object is already in R2,
  //    so the helper's default syncState='synced' is correct.
  const source = body.source ?? "direct-upload";
  const result = await createAssetRow({
    workspaceId: upload.workspaceId,
    userId: user.id,
    userEmail: user.email ?? null,
    filename: upload.filename,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    sha256,
    buffer,
    source,
  });

  // 5) Mark the upload row completed (even if dedup short-circuited — we
  //    still want to flip it out of pending). The R2 object is left in place
  //    in dedup case for forensic recovery; a future janitor sweep can drop
  //    orphans.
  await db
    .update(schema.assetUploads)
    .set({ state: "completed", assetId: result.asset.id, updatedAt: new Date() })
    .where(eq(schema.assetUploads.id, uploadId));

  const status = result.deduplicated ? 200 : 201;
  return NextResponse.json(
    {
      asset: serializeAsset(result.asset),
      ...(result.deduplicated ? { deduplicated: true } : {}),
      ...(result.possibleDuplicate ? { possibleDuplicate: result.possibleDuplicate } : {}),
    },
    { status }
  );
}
