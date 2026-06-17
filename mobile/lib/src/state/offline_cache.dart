// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// On-device image cache for offline browsing. Two bounded stores keyed by ASSET
// ID (not the presigned URL) so cached bytes survive the hourly URL rotation —
// the bug that made "seen" photos vanish offline once their signed URL expired.
//
// Bounding by object count per store (flutter_cache_manager's native eviction)
// keeps it simple + DB-consistent, and splitting thumbs from previews lets each
// type get a sensible budget that together targets ~1 GB:
//   thumbs   ~256px webp  ~30 KB  × 15000  ≈ 450 MB
//   previews ~1080px webp ~250 KB ×  2200  ≈ 550 MB
// Oldest objects are evicted first once a store is full (LRU-ish), so the cache
// self-trims to the user's recent/most-viewed library.

import "package:flutter_cache_manager/flutter_cache_manager.dart";

class OfflineCache {
  OfflineCache._();

  static const _stale = Duration(days: 90);

  /// Grid thumbnails. High object cap — thumbs are tiny and we want broad
  /// offline grid coverage.
  static final CacheManager thumbs = CacheManager(
    Config(
      "fontoThumbs",
      stalePeriod: _stale,
      maxNrOfCacheObjects: 15000,
    ),
  );

  /// Full-screen previews. Lower cap — previews are ~8× a thumb, so we keep the
  /// most-recent window viewable offline without blowing the storage budget.
  static final CacheManager previews = CacheManager(
    Config(
      "fontoPreviews",
      stalePeriod: _stale,
      maxNrOfCacheObjects: 2200,
    ),
  );

  /// Best-effort warm of one image into a store under a stable [assetId] key.
  /// Swallows failures (offline / expired URL) — prefetch is never fatal.
  static Future<void> warm(
    CacheManager store,
    String assetId,
    String url,
  ) async {
    if (url.isEmpty) return;
    try {
      await store.downloadFile(url, key: assetId);
    } catch (_) {
      // Network error / expired URL — skip; the next online pass retries.
    }
  }
}
