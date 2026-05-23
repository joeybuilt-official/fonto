// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.2 (parity): step 1 of the two-step direct-to-R2 upload.
//
// The client calls this with file metadata. We:
//  - Reserve an `asset_uploads` row in state=pending.
//  - Generate a presigned PUT URL (15-minute TTL) against the same R2 layout
//    the legacy POST uses (`fonto/{workspaceId}/{uploadUuid}/{filename}`).
//  - Return the URL plus the exact header object the client must replay on
//    its PUT (Content-Type, the same value we signed the URL with).
//
// The client then PUTs the body directly to R2 (zero Next.js memory) and
// finally calls POST /api/v1/assets/:uploadId/complete to finalize the row.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";

const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
const PRESIGN_EXPIRES_SECONDS = 15 * 60;

const InitRequestSchema = z.object({
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  /** Optional client-side SHA-256 (lowercase hex). */
  clientChecksum: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  /**
   * Phase 3.5 — optional virtual folder path. Pre-validation is loose
   * (just bound the length); `normalizeDirectoryPath` does the real shape
   * check and returns null if the input is unusable.
   */
  path: z.string().max(2048).optional(),
});

function maxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.floor(n);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }
  const workspaceId = workspaces[0].id;

  // Phase 3.1 — editor or higher required to initiate uploads.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  let body: z.infer<typeof InitRequestSchema>;
  try {
    body = InitRequestSchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid request body", details: err instanceof z.ZodError ? err.flatten() : undefined },
      { status: 400 }
    );
  }

  const cap = maxUploadBytes();
  if (body.sizeBytes > cap) {
    return NextResponse.json(
      { error: `File too large. Maximum upload size is ${cap} bytes.`, maxBytes: cap },
      { status: 413 }
    );
  }

  const uploadId = randomUUID();
  const storageKey = assetStorageKey(workspaceId, uploadId, body.filename);
  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    return NextResponse.json({ error: "R2_BUCKET not configured" }, { status: 500 });
  }

  // Sign a PUT with the exact Content-Type the client must replay. R2 (S3)
  // includes signed headers in the signature, so the client MUST echo this
  // value on its PUT or the upload will be rejected.
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ContentType: body.mimeType,
    ContentLength: body.sizeBytes,
  });

  let presignedUrl: string;
  try {
    presignedUrl = await getSignedUrl(getS3Client(), command, {
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });
  } catch (err) {
    console.error("[fonto] presign failed:", err);
    return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
  }

  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRES_SECONDS * 1000);

  const directoryPath = normalizeDirectoryPath(body.path, {
    filename: body.filename,
  });

  await db.insert(schema.assetUploads).values({
    id: uploadId,
    workspaceId,
    userId: user.id,
    filename: body.filename,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
    clientChecksum: body.clientChecksum ?? null,
    storageKey,
    state: "pending",
    presignedExpiresAt: expiresAt,
    directoryPath,
  });

  return NextResponse.json(
    {
      uploadId,
      presignedUrl,
      // Exact headers the client must apply on the PUT — match what we signed.
      // `Content-Length` is set automatically by the browser; only echo back
      // headers AWS bakes into the signature.
      headers: {
        "Content-Type": body.mimeType,
      },
      expiresAt: expiresAt.toISOString(),
      expiresIn: PRESIGN_EXPIRES_SECONDS,
      storageKey,
    },
    { status: 201 }
  );
}
