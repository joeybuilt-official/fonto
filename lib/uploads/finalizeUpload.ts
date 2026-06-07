// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared finalize step for the direct-to-R2 upload flow. Both
// /api/v1/uploads/{assetId}/complete (canonical) and the legacy
// /api/v1/assets/{id}/complete route call into this so the post-upload
// bookkeeping never drifts.
//
// Given a reserved `assetUploads` row whose bytes the client has already PUT
// to R2 via the presigned URL, this:
//   1. HEADs the R2 object to confirm it exists and the size matches /presign.
//   2. Computes the SHA-256 by STREAMING the object (never buffer-then-hash),
//      unless SKIP_SERVER_CHECKSUM is set and the client supplied a checksum.
//   3. Buffers the object once for EXIF/pHash and hands it to createAssetRow
//      (dedup + EXIF + pHash + insert + the SAME processing enqueue the legacy
//      multipart path uses).
//   4. Flips the upload row to completed with assetId set + bumps workspace
//      usage (skipping dedup, already counted).
//
// It does NOT own the HTTP response or auth — callers gate access and shape
// the reply.

import { createHash } from "crypto";
import {
  HeadObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { db, schema } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { getS3Client } from "@/lib/r2";
import {
  createAssetRow,
  type CreateAssetResult,
} from "@/lib/assets/createAssetRow";

export type AssetUpload = typeof schema.assetUploads.$inferSelect;

export type FinalizeUploadOutcome =
  | { ok: true; result: CreateAssetResult; replay: false }
  | { ok: true; asset: typeof schema.assets.$inferSelect; replay: true }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

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
  if (body instanceof Readable) {
    for await (const chunk of body) hash.update(chunk as Buffer);
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

/**
 * Finalize a direct upload whose bytes are already in R2. Caller has already
 * loaded + access-gated the `assetUploads` row.
 */
export async function finalizeUpload(
  upload: AssetUpload,
  opts: { userId: string; userEmail?: string | null; source?: string }
): Promise<FinalizeUploadOutcome> {
  // Idempotent replay: the upload was already completed.
  if (upload.state === "completed" && upload.assetId) {
    const [existingAsset] = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, upload.assetId))
      .limit(1);
    if (existingAsset) return { ok: true, asset: existingAsset, replay: true };
  }
  if (upload.state === "aborted") {
    return { ok: false, status: 410, error: "Upload was aborted" };
  }
  // 60s grace past expiry — a PUT racing the clock shouldn't fail to finalize.
  if (upload.presignedExpiresAt.getTime() < Date.now() - 60_000) {
    await db
      .update(schema.assetUploads)
      .set({ state: "aborted", updatedAt: new Date() })
      .where(eq(schema.assetUploads.id, upload.id));
    return { ok: false, status: 410, error: "Upload URL expired" };
  }

  const bucket = process.env.R2_BUCKET;
  if (!bucket) return { ok: false, status: 500, error: "R2_BUCKET not configured" };
  const s3 = getS3Client();

  // 1) HEAD: confirm the object exists and matches the declared size.
  let headSize: number | null = null;
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: upload.storageKey })
    );
    headSize = typeof head.ContentLength === "number" ? head.ContentLength : null;
  } catch (err) {
    console.error("[fonto] R2 HEAD failed:", err);
    return { ok: false, status: 404, error: "Upload object not found in storage" };
  }
  if (headSize == null || headSize !== upload.sizeBytes) {
    return {
      ok: false,
      status: 409,
      error: "Uploaded object size does not match presign declaration",
      extra: { expected: upload.sizeBytes, actual: headSize },
    };
  }

  // 2) SHA-256. Stream the body unless the client supplied a checksum AND
  //    SKIP_SERVER_CHECKSUM is enabled.
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
      return { ok: false, status: 500, error: "Failed to verify upload" };
    }
    if (upload.clientChecksum && upload.clientChecksum.toLowerCase() !== sha256) {
      return {
        ok: false,
        status: 409,
        error: "Client SHA-256 does not match server-computed SHA-256",
      };
    }
  }

  // 3) EXIF/pHash need the bytes in memory. Second GET; for video/RAW this is a
  //    no-op (extractExif returns nulls) but createAssetRow expects a buffer.
  let buffer: Buffer;
  try {
    const get = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: upload.storageKey })
    );
    buffer = await bufferS3Body(get.Body);
  } catch (err) {
    console.error("[fonto] R2 GET for EXIF failed:", err);
    return { ok: false, status: 500, error: "Failed to read upload" };
  }

  // 4) Shared row build: dedup + EXIF + pHash + insert + processing enqueue.
  //    Object is already in R2, so createAssetRow's default syncState='synced'
  //    is correct.
  // upload.id was used as the UUID segment in the storage key path at presign
  // time, so pre-reserve it as the asset ID so workers can derive the key via
  // assetStorageKey(workspaceId, asset.id, filename) without a separate lookup.
  // On SHA-256 dedup the existing asset row wins and preReservedId is ignored.
  const result = await createAssetRow({
    workspaceId: upload.workspaceId,
    userId: opts.userId,
    userEmail: opts.userEmail ?? null,
    filename: upload.filename,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    sha256,
    buffer,
    source: opts.source ?? "direct-upload",
    directoryPath: upload.directoryPath ?? null,
    preReservedId: upload.id,
  });

  // 5) Flip the upload row out of pending (even on dedup). The R2 object is
  //    left in place on dedup for forensic recovery; a janitor sweep drops
  //    orphans.
  await db
    .update(schema.assetUploads)
    .set({ state: "completed", assetId: result.asset.id, updatedAt: new Date() })
    .where(eq(schema.assetUploads.id, upload.id));

  // Bump workspace usage atomically (skip dedup — already counted).
  if (!result.deduplicated) {
    await db
      .update(schema.workspaces)
      .set({ usageBytes: sql`${schema.workspaces.usageBytes} + ${upload.sizeBytes}` })
      .where(eq(schema.workspaces.id, upload.workspaceId));
  }

  return { ok: true, result, replay: false };
}
