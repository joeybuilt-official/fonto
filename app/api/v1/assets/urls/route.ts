// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — batch presigned URL endpoint. Replaces the per-card N+1 round-trip
// pattern (photo-card.tsx, memories, collections, dashboard each fire one
// GET /api/v1/assets/:id/url per tile on render) with a single POST that
// signs every URL in one call.
//
// Request shapes (backwards compatible):
//
//   Single-variant (legacy):
//     POST /api/v1/assets/urls
//     { "ids": ["<uuid>", ...], "variant": "thumb" | "preview" | ... }
//
//     Response: { urls: { [id]: "<signed-url>" },
//                 variants: { [id]: "<served-variant>" },
//                 expiresIn: 3600 }
//
//   Multi-variant (T2.3b — fonto-perf-audit responsive thumbs):
//     POST /api/v1/assets/urls
//     { "ids": ["<uuid>", ...],
//       "variants": ["thumb", "thumb-256-avif", "thumb-512-webp", ...] }
//
//     Response: { urls: { [id]: { [variant]: "<signed-url>" } },
//                 expiresIn: 3600 }
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
import { resolveVariantKey, type Variant } from "@/lib/assets/variants";

const KNOWN_VARIANTS: ReadonlySet<Variant> = new Set<Variant>([
  "thumb",
  "preview",
  "original",
  "thumb-256-avif",
  "thumb-512-webp",
  "thumb-512-avif",
  "thumb-1024-webp",
  "thumb-1024-avif",
  "preview-avif",
]);

function parseVariant(raw: unknown): Variant {
  if (typeof raw === "string" && KNOWN_VARIANTS.has(raw as Variant)) {
    return raw as Variant;
  }
  return "thumb";
}

function parseVariants(raw: unknown): Variant[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Variant[] = [];
  for (const v of raw) {
    if (typeof v === "string" && KNOWN_VARIANTS.has(v as Variant)) {
      out.push(v as Variant);
    }
  }
  return out.length > 0 ? out : null;
}

// Cap on a single batch. The Flutter People grid loads cover thumbs for
// EVERY person cluster in a single shot (no virtualisation on that screen
// yet) and a seed-library workspace can have 2k+ clusters — 500 was too
// tight and 4xx'd the whole grid into "Couldn't load this". Bumped to 5000;
// the underlying R2 sign loop is O(n) but each sign is sub-ms so the
// per-call wall-clock cost is still well under 1s for the worst case.
const MAX_BATCH = 5000;

// Presign TTLs. Derivatives (thumb/responsive/preview) are cheap, immutable,
// content-addressed by variant key, and safe to hand out long-lived — so we
// sign them toward the SigV4 ceiling (7 days) to slash re-sign churn on grids
// that keep the same thumb URL across a session. Originals are full-res +
// sensitive, so they stay short-lived and get re-signed on demand.
const ORIGINAL_TTL_SECONDS = 3600; // 1 hour
const DERIVATIVE_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800 — AWS SigV4 max

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

  // Multi-variant request takes precedence when both are supplied. The
  // multi-variant response shape differs (urls keyed by id → variant → url)
  // so callers must opt in explicitly by sending `variants`.
  const multiVariants = parseVariants((body as { variants?: unknown }).variants);
  const variant = parseVariant((body as { variant?: unknown }).variant);

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    if (multiVariants) {
      return NextResponse.json({ urls: {}, expiresIn: 3600 });
    }
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
      thumbnail256AvifKey: schema.assets.thumbnail256AvifKey,
      thumbnail512WebpKey: schema.assets.thumbnail512WebpKey,
      thumbnail512AvifKey: schema.assets.thumbnail512AvifKey,
      thumbnail1024WebpKey: schema.assets.thumbnail1024WebpKey,
      thumbnail1024AvifKey: schema.assets.thumbnail1024AvifKey,
      previewAvifKey: schema.assets.previewAvifKey,
    })
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.id, ids),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    );

  // Sign in parallel. The presigner is a pure crypto op (no network), so
  // Promise.all is bounded by CPU not RTT; even at the 5000-id cap this
  // resolves in a handful of ms per variant.
  async function signFor(
    asset: (typeof rows)[number],
    v: Variant
  ): Promise<{ url: string; served: Variant }> {
    const resolved = resolveVariantKey(asset, v);
    const key = resolved.key
      ? resolved.key
      : assetStorageKey(asset.workspaceId, asset.id, asset.filename);
    const served: Variant = resolved.key ? resolved.resolvedVariant : "original";
    const expiresIn =
      served === "original" ? ORIGINAL_TTL_SECONDS : DERIVATIVE_TTL_SECONDS;
    const url = await storage().presignGet(key, { expiresIn });
    return { url, served };
  }

  if (multiVariants) {
    const entries = await Promise.all(
      rows.map(async (asset) => {
        const perVariant: Record<string, string> = {};
        const signed = await Promise.all(
          multiVariants.map((v) => signFor(asset, v))
        );
        // Key the response by the REQUESTED variant token, not the served
        // one, so the client gets the keys it asked for. The fallback chain
        // just transparently substitutes an older derivative under the hood.
        multiVariants.forEach((v, idx) => {
          perVariant[v] = signed[idx].url;
        });
        return [asset.id, perVariant] as const;
      })
    );

    const urls: Record<string, Record<string, string>> = {};
    for (const [id, perVariant] of entries) {
      urls[id] = perVariant;
    }

    // Multi-variant responses are derivative-only by definition (the
    // responsive set doesn't include `original`), so the long derivative TTL
    // and matching max-age are always safe.
    return NextResponse.json(
      { urls, expiresIn: DERIVATIVE_TTL_SECONDS },
      { headers: { "Cache-Control": `private, max-age=${DERIVATIVE_TTL_SECONDS}` } }
    );
  }

  const entries = await Promise.all(
    rows.map(async (asset) => {
      const { url, served } = await signFor(asset, variant);
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
  const expiresIn = anyOriginal ? ORIGINAL_TTL_SECONDS : DERIVATIVE_TTL_SECONDS;
  if (!anyOriginal) {
    headers["Cache-Control"] = `private, max-age=${DERIVATIVE_TTL_SECONDS}`;
  }

  return NextResponse.json(
    { urls, variants, expiresIn },
    { headers }
  );
}
