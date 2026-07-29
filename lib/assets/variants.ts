// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// T2.3b (fonto-perf-audit) — responsive derivative variant taxonomy.
//
// The asset row owns up to 8 derivative R2 keys (plus the original):
//
//   thumbnailKey            256 webp (legacy)
//   thumbnail256AvifKey     256 avif
//   thumbnail512WebpKey     512 webp
//   thumbnail512AvifKey     512 avif
//   thumbnail1024WebpKey    1024 webp
//   thumbnail1024AvifKey    1024 avif
//   previewKey              1080 webp (legacy)
//   previewAvifKey          1080 avif
//
// AVIF variants fall back to the same-size WebP, then to the legacy 256-webp
// thumbnail (or legacy 1080-webp preview). This way the client can always
// request a modern variant and the API never 404s on an unbackfilled row.

import type { assets } from "@/lib/db/schema";

type AssetRow = typeof assets.$inferSelect;

export type Variant =
  | "thumb"
  | "preview"
  | "original"
  | "face"
  | "thumb-256-avif"
  | "thumb-512-webp"
  | "thumb-512-avif"
  | "thumb-1024-webp"
  | "thumb-1024-avif"
  | "preview-avif";

export interface ResolvedVariant {
  /** R2 key. `null` means the variant (and all its fallbacks) are NULL on the
   *  row — caller should sign the original instead. */
  key: string | null;
  /** Which token the key actually corresponds to. Useful so the JSON
   *  response can tell the client the served variant. */
  resolvedVariant: Variant;
}

type AssetForVariant = Pick<
  AssetRow,
  | "thumbnailKey"
  | "previewKey"
  | "thumbnail256AvifKey"
  | "thumbnail512WebpKey"
  | "thumbnail512AvifKey"
  | "thumbnail1024WebpKey"
  | "thumbnail1024AvifKey"
  | "previewAvifKey"
>;

/**
 * Walks the fallback chain for a derivative variant and returns the first
 * non-null R2 key on the asset row. `face` is handled by the caller (the
 * crop key lives on a different table).
 *
 * Fallback chains:
 *   thumb-N-avif → thumb-N-webp → thumb (legacy 256 webp)
 *   thumb-N-webp → thumb (legacy 256 webp)
 *   preview-avif → preview (legacy 1080 webp)
 *   thumb / preview / original → no fallback (preview falls to original at
 *     the caller, original signs the source key)
 */
export function resolveVariantKey(
  asset: AssetForVariant,
  variant: Variant
): ResolvedVariant {
  switch (variant) {
    case "original":
    case "face":
      return { key: null, resolvedVariant: variant };

    case "thumb":
      return asset.thumbnailKey
        ? { key: asset.thumbnailKey, resolvedVariant: "thumb" }
        : { key: null, resolvedVariant: "original" };

    case "preview":
      return asset.previewKey
        ? { key: asset.previewKey, resolvedVariant: "preview" }
        : { key: null, resolvedVariant: "original" };

    case "thumb-256-avif":
      if (asset.thumbnail256AvifKey)
        return { key: asset.thumbnail256AvifKey, resolvedVariant: "thumb-256-avif" };
      if (asset.thumbnailKey)
        return { key: asset.thumbnailKey, resolvedVariant: "thumb" };
      return { key: null, resolvedVariant: "original" };

    case "thumb-512-avif":
      if (asset.thumbnail512AvifKey)
        return { key: asset.thumbnail512AvifKey, resolvedVariant: "thumb-512-avif" };
      if (asset.thumbnail512WebpKey)
        return { key: asset.thumbnail512WebpKey, resolvedVariant: "thumb-512-webp" };
      if (asset.thumbnailKey)
        return { key: asset.thumbnailKey, resolvedVariant: "thumb" };
      return { key: null, resolvedVariant: "original" };

    case "thumb-512-webp":
      if (asset.thumbnail512WebpKey)
        return { key: asset.thumbnail512WebpKey, resolvedVariant: "thumb-512-webp" };
      if (asset.thumbnailKey)
        return { key: asset.thumbnailKey, resolvedVariant: "thumb" };
      return { key: null, resolvedVariant: "original" };

    case "thumb-1024-avif":
      if (asset.thumbnail1024AvifKey)
        return { key: asset.thumbnail1024AvifKey, resolvedVariant: "thumb-1024-avif" };
      if (asset.thumbnail1024WebpKey)
        return { key: asset.thumbnail1024WebpKey, resolvedVariant: "thumb-1024-webp" };
      if (asset.thumbnailKey)
        return { key: asset.thumbnailKey, resolvedVariant: "thumb" };
      return { key: null, resolvedVariant: "original" };

    case "thumb-1024-webp":
      if (asset.thumbnail1024WebpKey)
        return { key: asset.thumbnail1024WebpKey, resolvedVariant: "thumb-1024-webp" };
      if (asset.thumbnailKey)
        return { key: asset.thumbnailKey, resolvedVariant: "thumb" };
      return { key: null, resolvedVariant: "original" };

    case "preview-avif":
      if (asset.previewAvifKey)
        return { key: asset.previewAvifKey, resolvedVariant: "preview-avif" };
      if (asset.previewKey)
        return { key: asset.previewKey, resolvedVariant: "preview" };
      return { key: null, resolvedVariant: "original" };
  }
}
