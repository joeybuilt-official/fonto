// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — batch presigned URL endpoint. Replaces the per-card N+1 round-trip
// pattern (photo-card.tsx, memories, collections, dashboard each fire one
// GET /api/v1/assets/:id/url per tile on render) with a single POST that
// signs every URL in one call.
//
// Request:
//   POST /api/v1/assets/urls
//   { "ids": ["<uuid>", "<uuid>", ...],
//     "variant": "thumb" | "preview" | "original" }  // optional, default "thumb"
//
// Response:
//   { "urls": { "<id>": "<signed-url>", ... },
//     "variants": { "<id>": "thumb" | "preview" | "original" },
//     "expiresIn": 3600 }
//
// Workspace scoping mirrors the single-id route: any id the caller can't see
// is silently dropped from `urls` (no error, no 404). This matches how the
// grids currently behave when an asset is deleted mid-render.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, inArray } from "drizzle-orm";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";

type Variant = "thumb" | "preview" | "original";

function parseVariant(raw: unknown): Variant {
  if (raw === "thumb" || raw === "preview" || raw === "original") return raw;
  return "thumb";
}

// Cap on a single batch. 500 covers the largest realistic grid page (the
// virtualised AssetGrid only renders ~200 visible at a time; 500 gives
// headroom for prefetch). Larger requests are rejected outright rather than
// silently truncated so callers can't accidentally rely on partial fills.
const MAX_BATCH = 500;

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = Array.isArray((body as { ids?: unknown })?.ids)
    ? ((body as { ids: unknown[] }).ids.filter(
        (x): x is string => typeof x === "string" && x.length > 0
      ))
    : null;
  if (!ids || ids.length === 0) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many ids; max ${MAX_BATCH} per request` },
      { status: 400 }
    );
  }

  const variant = parseVariant((body as { variant?: unknown }).variant);

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ urls: {}, variants: {}, expiresIn: 3600 });
  }
  const workspaceIds = workspaces.map((w) => w.id);

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      thumbnailKey: schema.assets.thumbnailKey,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.id, ids),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    );

  // Sign in parallel. The presigner is a pure crypto op (no network), so
  // Promise.all is bounded by CPU not RTT; even at the 500-id cap this
  // resolves in a handful of ms.
  const entries = await Promise.all(
    rows.map(async (asset) => {
      let key: string;
      let served: Variant = variant;
      if (variant === "thumb" && asset.thumbnailKey) {
        key = asset.thumbnailKey;
      } else if (variant === "preview" && asset.previewKey) {
        key = asset.previewKey;
      } else {
        key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
        served = "original";
      }
      const url = await storage().presignGet(key, { expiresIn: 3600 });
      return [asset.id, { url, served }] as const;
    })
  );

  const urls: Record<string, string> = {};
  const variants: Record<string, Variant> = {};
  for (const [id, { url, served }] of entries) {
    urls[id] = url;
    variants[id] = served;
  }

  // All-derivative responses are cacheable for the variant lifetime; if any
  // entry fell back to `original`, omit the cache header to match the
  // single-id route's no-store behaviour for originals.
  const headers: Record<string, string> = {};
  const anyOriginal = Object.values(variants).some((v) => v === "original");
  if (!anyOriginal) {
    headers["Cache-Control"] = "private, max-age=3600";
  }

  return NextResponse.json(
    { urls, variants, expiresIn: 3600 },
    { headers }
  );
}
