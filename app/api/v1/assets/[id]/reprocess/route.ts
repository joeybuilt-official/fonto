// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// User-triggered re-scan of a single asset: re-runs the FULL recognition
// pipeline (classify + describe + OCR via the local plexo-vision/Ollama
// path, plus CLIP embedding, vision "things" labels, and face detection) —
// the same work the upload path enqueues. Reachable from the web lightbox
// and the mobile asset detail screen.
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { enqueueAssetProcessing } from "@/lib/assets/createAssetRow";
import { cacheInvalidate } from "@/lib/cache/valkey";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Reset to the pre-processing state so the asset reappears in the
  // "processing" count and the pipeline re-derives everything from scratch.
  await db
    .update(schema.assets)
    .set({ processingState: "captured" })
    .where(eq(schema.assets.id, id));

  await enqueueAssetProcessing({
    assetId: asset.id,
    workspaceId: asset.workspaceId,
    userId: user.id,
    userEmail: user.email,
    filename: asset.filename,
    mimeType: asset.mimeType,
  });

  // T1.3' — processingState change is part of the serialized asset payload
  // cached by collection-assets / smart-collection-assets aggregates.
  revalidateTag(`ws:${asset.workspaceId}:assets`, "max");
  void cacheInvalidate(`ws:${asset.workspaceId}:assets`);

  return NextResponse.json({ queued: true });
}
