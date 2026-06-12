// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 8b — HLS playback proxy.
//
//   GET /api/v1/assets/:id/hls/playback/<file>
//     <file> matches the keys under fonto/{ws}/{id}/hls/ in R2:
//       master.m3u8, 360p.m3u8, 360p_NNN.ts, 720p.m3u8, …
//
// For .m3u8 (tiny text): fetches from R2 and serves the bytes
//   directly so the BROWSER resolves relative children against THIS
//   URL path (not the R2 hostname). That way every child fetch also
//   passes back through this auth-gated proxy.
// For .ts (large segment): 302 redirects to a short-lived presigned
//   R2 URL so the bytes go browser → R2 direct (no Next.js bandwidth).
//
// Why not just public-read the R2 bucket: that leaks shared-asset
// segments to anyone who can guess the key + workspace UUID. The auth
// hop is cheap (~5ms per segment) and keeps the access model honest.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { resolveAssetAccess } from "@/lib/assets/access";
import { storage } from "@/lib/storage";
import { hlsSegmentKeyPrefix } from "@/lib/r2";

const ALLOWED_FILE = /^[a-zA-Z0-9._-]+$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!path || path.length !== 1 || !ALLOWED_FILE.test(path[0])) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  const file = path[0];

  const access = await resolveAssetAccess(user.id, id);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const asset = access.asset;
  if (asset.hlsState !== "ready") {
    return NextResponse.json({ error: "Not ready" }, { status: 409 });
  }

  const key = `${hlsSegmentKeyPrefix(asset.workspaceId, asset.id)}${file}`;

  // m3u8 playlists: pull bytes through so browser uses THIS path as
  // the base for resolving children. Cheap — playlists are <2 KB.
  if (file.endsWith(".m3u8")) {
    try {
      const buf = await storage().getBuffer(key);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "R2 fetch failed", detail: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
  }

  // .ts segment: stream the bytes through this proxy rather than 302ing
  // to a presigned R2 URL. A redirect breaks native players (Android
  // ExoPlayer / iOS) that carry the request's `Authorization: Bearer`
  // header across the cross-origin hop — R2 rejects a presigned URL that
  // also carries an Authorization header ("only one auth mechanism").
  // Browsers strip auth on cross-origin redirects so they were fine, but
  // the app was not. Streaming keeps a single auth model for both.
  if (file.endsWith(".ts")) {
    const range = request.headers.get("range") ?? undefined;
    try {
      const { body, contentLength, contentRange } = await storage().getStream(key, { range });
      const headers: Record<string, string> = {
        "Content-Type": "video/mp2t",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=300, immutable",
      };
      if (contentLength != null) headers["Content-Length"] = String(contentLength);
      if (contentRange) headers["Content-Range"] = contentRange;
      return new NextResponse(body, {
        status: contentRange ? 206 : 200,
        headers,
      });
    } catch (err) {
      return NextResponse.json(
        { error: "R2 fetch failed", detail: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
}
