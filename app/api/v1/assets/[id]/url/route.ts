// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { resolveAssetAccess } from "@/lib/assets/access";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { resolveVariantKey, type Variant } from "@/lib/assets/variants";

// Phase 1.1 — variant query param. `original` keeps the legacy behavior;
// `thumb` / `preview` resolve the derivative R2 keys if present (and fall
// back to the original when NULL, so legacy assets keep rendering until the
// backfill catches them).
// Phase 1 (faces/UX) — `face` resolves a single face's dedicated crop key
// (requires &faceId=…); the face must belong to this asset's workspace.
// T2.3b (fonto-perf-audit) — extended with responsive AVIF/WebP variants
// (thumb-{256,512,1024}-{webp,avif}, preview-avif). The `resolveVariantKey`
// helper centralises the fallback chain so the batch route shares behaviour.

function parseVariant(raw: string | null): Variant {
  switch (raw) {
    case "thumb":
    case "preview":
    case "original":
    case "face":
    case "thumb-256-avif":
    case "thumb-512-webp":
    case "thumb-512-avif":
    case "thumb-1024-webp":
    case "thumb-1024-avif":
    case "preview-avif":
      return raw;
    default:
      return "original";
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Phase 7b — resolve via either source-workspace membership OR an
  // active cross-workspace share grant. Read-side routes allow both
  // paths so shared recipients can render the asset's bytes.
  const access = await resolveAssetAccess(user.id, id);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const asset = access.asset;

  // M12 / ADR 0014 — motion clip playback. Resolves the extracted Android
  // derivative (`motionVideoKey`) first, else the paired Apple MOV's original.
  // Kept out of the typed `Variant` chain since it may presign a DIFFERENT
  // asset's bytes (the companion).
  if (request.nextUrl.searchParams.get("variant") === "motion") {
    let motionKey: string | null = asset.motionVideoKey ?? null;
    if (!motionKey && asset.motionCompanionAssetId) {
      const [companion] = await db
        .select({
          id: schema.assets.id,
          workspaceId: schema.assets.workspaceId,
          filename: schema.assets.filename,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, asset.motionCompanionAssetId))
        .limit(1);
      if (companion) {
        motionKey = assetStorageKey(companion.workspaceId, companion.id, companion.filename);
      }
    }
    if (!motionKey) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const motionUrl = await storage().presignGet(motionKey, { expiresIn: 3600 });
    return NextResponse.json(
      { url: motionUrl, expiresIn: 3600, variant: "motion" },
      // `private` (not `public`): the body carries a per-caller presigned URL;
      // a shared proxy/CDN must not cache and replay it to another user.
      { headers: { "Cache-Control": "private, max-age=3600" } }
    );
  }

  const variant = parseVariant(request.nextUrl.searchParams.get("variant"));

  // Pick the R2 key based on the requested variant. Derivatives may be NULL
  // for legacy / non-image / unbackfilled rows — fall through to the
  // original key (or the next-best legacy variant) so the client never sees
  // a 404 because of an in-flight backfill.
  let key: string;
  let servedVariant: Variant = variant;
  if (variant === "face") {
    // Resolve a single face's dedicated crop. The face must belong to this
    // asset (and so to a workspace the caller can already read this asset in).
    const faceId = request.nextUrl.searchParams.get("faceId");
    if (!faceId) {
      return NextResponse.json({ error: "faceId required" }, { status: 400 });
    }
    const [face] = await db
      .select({ faceCropKey: schema.faceInstances.faceCropKey })
      .from(schema.faceInstances)
      .where(
        and(
          eq(schema.faceInstances.id, faceId),
          eq(schema.faceInstances.assetId, asset.id),
          eq(schema.faceInstances.workspaceId, asset.workspaceId)
        )
      )
      .limit(1);
    if (!face) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (face.faceCropKey) {
      key = face.faceCropKey;
    } else {
      // Crop not generated yet — fall back to the preview (or original) so the
      // client still renders something while the backfill catches up.
      key = asset.previewKey
        ? asset.previewKey
        : assetStorageKey(asset.workspaceId, asset.id, asset.filename);
      servedVariant = asset.previewKey ? "preview" : "original";
    }
  } else {
    const resolved = resolveVariantKey(asset, variant);
    if (resolved.key) {
      key = resolved.key;
      servedVariant = resolved.resolvedVariant;
    } else {
      key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
      servedVariant = "original";
    }
  }

  const url = await storage().presignGet(key, { expiresIn: 3600 });

  // Cache-Control on the JSON response itself: derivative URLs are stable
  // for the variant lifetime, so an hour of caching on the JSON wrapper is
  // safe. Originals stay no-store to preserve current behavior.
  const headers: Record<string, string> = {};
  if (servedVariant !== "original") {
    // `private` (not `public`): the JSON body wraps a per-caller presigned R2
    // URL — a shared proxy/CDN must not cache and replay it to another user.
    // Matches the batch route (/api/v1/assets/urls).
    headers["Cache-Control"] = "private, max-age=3600";
  }

  return NextResponse.json(
    { url, expiresIn: 3600, variant: servedVariant },
    { headers }
  );
}
