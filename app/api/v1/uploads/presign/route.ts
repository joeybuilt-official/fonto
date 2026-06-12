// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Direct-to-R2 upload — step 1: mint a presigned PUT URL.
//
// This is the canonical entry point for the direct-upload flow. Bytes go
// client → R2 with zero Next.js memory; the server only reserves a row and
// signs the URL. Step 2 is POST /api/v1/uploads/{assetId}/complete.
//
// Contract (matches the mobile + web clients):
//   POST body  { filename, mimeType, sizeBytes, sha256?, path? }
//   201 reply  { assetId, uploadUrl, key, expiresAt, expiresIn }
//
// `assetId` is the UUID we reserve for this upload (it's embedded in the R2
// key as `fonto/{workspaceId}/{assetId}/{filename}` and is the path segment
// /complete is called with). It is NOT the final asset row id — that row is
// materialized by /complete and may differ when a SHA-256 dedup hit returns
// an existing asset.
//
// This route shares the exact `assetUploads` table, key scheme (lib/r2
// assetStorageKey), presign pattern (getSignedUrl + PutObjectCommand), auth
// gate, quota preflight, and folder-path normalization as the legacy
// /api/v1/assets/init route, which it supersedes. /init stays for
// pre-migration web clients (lib/upload-client.ts).

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";

const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
// ~1h presign TTL per the direct-upload spec (the legacy /init used 15m).
const PRESIGN_EXPIRES_SECONDS = 60 * 60;
// Single-PUT hard ceiling. S3/R2 reject a single PutObject over 5 GiB; bigger
// files must use multipart, which this flow does not yet implement. Clients
// fall back to the legacy multipart POST (or, for resumable, tus) for these.
// See the >5 GiB note in the route below.
const SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

const PresignRequestSchema = z.object({
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  /** Optional client-side SHA-256 (lowercase hex). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  /** Optional virtual folder path; normalized server-side. */
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

  // Upload-only role (relaxed editor → contributor, same as /init + legacy POST).
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "contributor");
  if (!gate.ok) return gate.response;

  let body: z.infer<typeof PresignRequestSchema>;
  try {
    body = PresignRequestSchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid request body", details: err instanceof z.ZodError ? err.flatten() : undefined },
      { status: 400 }
    );
  }

  // Single-PUT ceiling: R2 rejects a presigned PutObject over 5 GiB. Surface a
  // clear, distinct error so the client can fall back to the legacy multipart
  // route (or tus) rather than getting an opaque R2 PUT failure.
  if (body.sizeBytes > SINGLE_PUT_MAX_BYTES) {
    return NextResponse.json(
      {
        error:
          "File exceeds the 5 GiB single-PUT limit for direct upload. Use the legacy /api/v1/assets multipart route or resumable tus upload.",
        maxSinglePutBytes: SINGLE_PUT_MAX_BYTES,
      },
      { status: 413 }
    );
  }

  const cap = maxUploadBytes();
  if (body.sizeBytes > cap) {
    return NextResponse.json(
      { error: `File too large. Maximum upload size is ${cap} bytes.`, maxBytes: cap },
      { status: 413 }
    );
  }

  // Quota preflight — block uploads that would push the workspace past its
  // quota_bytes limit. NULL quota = unlimited.
  const [ws] = await db
    .select({ quotaBytes: schema.workspaces.quotaBytes, usageBytes: schema.workspaces.usageBytes })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (ws?.quotaBytes != null) {
    const wouldUse = (ws.usageBytes ?? 0) + body.sizeBytes;
    if (wouldUse > ws.quotaBytes) {
      return NextResponse.json(
        { error: "Storage quota exceeded", quotaBytes: ws.quotaBytes, usageBytes: ws.usageBytes ?? 0 },
        { status: 413 }
      );
    }
  }

  const assetId = randomUUID();
  const key = assetStorageKey(workspaceId, assetId, body.filename);
  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    return NextResponse.json({ error: "R2_BUCKET not configured" }, { status: 500 });
  }

  // Sign a PUT with the exact Content-Type the client must replay. R2 (S3)
  // includes signed headers in the signature, so the client's PUT MUST send
  // this same Content-Type or the upload is rejected.
  let uploadUrl: string;
  try {
    uploadUrl = await storage().presignPut(key, {
      contentType: body.mimeType,
      contentLength: body.sizeBytes,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });
  } catch (err) {
    console.error("[fonto] presign failed:", err);
    return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
  }

  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRES_SECONDS * 1000);
  const directoryPath = normalizeDirectoryPath(body.path, { filename: body.filename });

  await db.insert(schema.assetUploads).values({
    id: assetId,
    workspaceId,
    userId: user.id,
    filename: body.filename,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
    clientChecksum: body.sha256 ?? null,
    storageKey: key,
    state: "pending",
    presignedExpiresAt: expiresAt,
    directoryPath,
  });

  return NextResponse.json(
    {
      assetId,
      uploadUrl,
      key,
      // Headers the client must replay on the PUT — must equal what we signed.
      headers: { "Content-Type": body.mimeType },
      expiresAt: expiresAt.toISOString(),
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    },
    { status: 201 }
  );
}
