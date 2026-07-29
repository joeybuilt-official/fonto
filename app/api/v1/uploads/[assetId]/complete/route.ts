// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Direct-to-R2 upload — step 2: finalize.
//
// The client has already PUT the bytes to R2 via the presigned URL from
// /api/v1/uploads/presign. The `{assetId}` path segment is the UUID that
// /presign issued (and embedded in the R2 key), NOT the final asset row id.
//
//   POST /api/v1/uploads/{assetId}/complete   body { source? }
//   201 { asset, possibleDuplicate? }          (200 + deduplicated on a hit)
//
// All the HEAD-confirm + stream-hash + createAssetRow + enqueue work lives in
// lib/uploads/finalizeUpload so this route and the legacy
// /api/v1/assets/{id}/complete stay in lockstep.

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { finalizeUpload } from "@/lib/uploads/finalizeUpload";
import { recordAuditEvent, AuditAction } from "@/lib/audit";
import { cacheInvalidate } from "@/lib/cache/valkey";

const CompleteRequestSchema = z.object({
  /** Optional client-recorded source label. */
  source: z.string().max(64).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
): Promise<NextResponse> {
  const { assetId: uploadId } = await params;

  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof CompleteRequestSchema> = {};
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

  // Look up the reserved upload row scoped to this user.
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

  // Upload-only role; redundant w/ the userId filter but defends a
  // role-downgrade race mid-upload.
  const gate = await requireWorkspaceAccessOrResponse(user.id, upload.workspaceId, "contributor");
  if (!gate.ok) return gate.response;

  const outcome = await finalizeUpload(upload, {
    userId: user.id,
    userEmail: user.email ?? null,
    source: body.source ?? "direct-upload",
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, ...(outcome.extra ?? {}) },
      { status: outcome.status }
    );
  }

  if (outcome.replay) {
    return NextResponse.json({ asset: serializeAsset(outcome.asset) }, { status: 200 });
  }

  const { result } = outcome;
  void recordAuditEvent({
    workspaceId: upload.workspaceId,
    userId: user.id,
    action: AuditAction.AssetUpload,
    targetType: "asset",
    targetId: result.asset.id,
    metadata: {
      filename: upload.filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      deduplicated: result.deduplicated,
      directUpload: true,
    },
    request,
  });

  // T1.3' — evict every aggregate cache that embeds asset rows/counts.
  revalidateTag(`ws:${upload.workspaceId}:assets`, "max");
  void cacheInvalidate(`ws:${upload.workspaceId}:assets`);

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
