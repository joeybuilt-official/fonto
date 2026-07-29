// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 8b — on-demand HLS playlist endpoint.
//
//   GET /api/v1/assets/:id/hls
//     - If hls_state='ready': returns presigned master playlist URL,
//       rendition metadata, and presigned sprite URL (if sprite_key
//       set). 200.
//     - If hls_state='idle' or 'failed': enqueues a transcode job and
//       returns { state: 'transcoding' } with 202. (The job handler
//       flips state to 'transcoding' before kicking off — see
//       worker/index.ts.)
//     - If hls_state='transcoding': returns 202 + state, no enqueue.
//
// Access: read-side. Uses lib/assets/access.ts so cross-workspace
// share recipients can play shared videos.
//
// Player polls this until ready. Could be replaced with a SSE channel
// later; for v1 a 3s polling loop in the lightbox is plenty.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { resolveAssetAccess } from "@/lib/assets/access";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { storage } from "@/lib/storage";
import { addVideoHlsTranscodeJob } from "@/lib/queue/queues";

// Same-origin path so the browser resolves the master's relative
// children (per-rendition playlists + .ts segments) back through this
// auth-gated proxy rather than against R2's hostname.
function playbackUrlFor(assetId: string, file: string): string {
  return `/api/v1/assets/${assetId}/hls/playback/${file}`;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await resolveAssetAccess(user.id, id);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const asset = access.asset;

  if (!asset.mimeType.startsWith("video/")) {
    return NextResponse.json({ error: "Not a video" }, { status: 400 });
  }

  if (asset.hlsState === "transcoding") {
    return NextResponse.json({ state: "transcoding" }, { status: 202 });
  }

  if (asset.hlsState === "idle" || asset.hlsState === "failed") {
    // Mark transcoding inline so a follow-up poll within the same
    // tick window doesn't re-enqueue. The worker will overwrite +
    // confirm; this just covers the gap between enqueue + pickup.
    await db
      .update(schema.assets)
      .set({ hlsState: "transcoding" })
      .where(eq(schema.assets.id, id));
    await addVideoHlsTranscodeJob({
      assetId: id,
      workspaceId: asset.workspaceId,
    });
    return NextResponse.json({ state: "transcoding", enqueued: true }, { status: 202 });
  }

  if (asset.hlsState !== "ready" || !asset.hlsMasterKey) {
    // Shouldn't happen given the branches above; defensive.
    return NextResponse.json({ state: asset.hlsState }, { status: 202 });
  }

  // Player loads the master through our proxy so segment auth still
  // applies. Sprite is a private R2 object too but it's safe to
  // presign directly — it's an image, single fetch, no relative
  // children that need resolution.
  const playlistUrl = playbackUrlFor(asset.id, "master.m3u8");
  let spriteUrl: string | null = null;
  if (asset.spriteKey) {
    spriteUrl = await storage().presignGet(asset.spriteKey, { expiresIn: 3600 });
  }

  return NextResponse.json(
    {
      state: "ready",
      playlistUrl,
      renditions: asset.hlsRenditions ?? [],
      spriteUrl,
      spriteMeta: asset.spriteMeta ?? null,
      expiresIn: 3600,
    },
    { headers: { "Cache-Control": "private, max-age=60" } }
  );
}
