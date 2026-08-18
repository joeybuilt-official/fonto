// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.2 (parity): step 2 of the two-step direct-to-R2 upload (legacy).
//
// Superseded by /api/v1/uploads/{assetId}/complete. Kept intact for the web
// client (lib/upload-client.ts) which still posts here behind
// NEXT_PUBLIC_DIRECT_UPLOAD. Both routes now share lib/uploads/finalizeUpload
// so the HEAD-confirm + stream-hash + createAssetRow + enqueue path never
// drifts between them.
//
// The `[id]` route segment is the `uploadId` (UUID issued by /init), NOT the
// final asset id — the final asset id lives on the row only after complete.

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
  // Optional, but accepted for symmetry with /init's response. We mainly
  // identify the upload via the `[id]` path segment.
  uploadId: z.string().uuid().optional(),
  /** Optional client-recorded source label. */
  source: z.string().max(64).optional(),
});

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

  // Phase 7b — relaxed editor → contributor. Completes the upload
  // started by the same user; redundant w/ the userId filter above but
  // defends against role-downgrade races mid-upload.
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
