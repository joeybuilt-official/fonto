// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Wi-Fi prefetch of the recent library for offline use. On a good connection we
// walk the newest assets, persist their metadata, and warm the thumbnail (and a
// shallower window of preview) caches — so the user can browse + open recent
// photos with no internet, even pages they never scrolled to.
//
// Best-effort + bounded: respects the "Wi-Fi only" setting via
// SyncService.transferableNow(), caps how much it pulls (well within the
// OfflineCache object budgets), re-checks connectivity each page, and never
// throws into the caller. Idempotent — re-runs warm the same id keys.

import "dart:async";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "auth_store.dart";
import "asset_cache.dart";
import "offline_cache.dart";
import "sync_service.dart";

class OfflinePrefetch {
  OfflinePrefetch._();

  static bool _running = false;

  // Bounds (stay within OfflineCache caps): warm thumbs broadly, previews for a
  // shallower recent window (they're ~8× the bytes).
  static const _maxThumbs = 4000;
  static const _maxPreviews = 600;
  static const _pageSize = 100;

  /// Kick a prefetch pass. Safe to call unawaited on app start. No-op if a pass
  /// is already running or the connection isn't transferable.
  static Future<void> run(AuthStore auth) async {
    if (_running || !auth.isConfigured) return;
    if (await SyncService.transferableNow() != TransferState.ok) return;
    _running = true;
    final client = FontoClient(auth);
    try {
      final cache = await AssetCache.open();
      AssetCursor? cursor;
      var thumbs = 0;
      var previews = 0;
      while (thumbs < _maxThumbs) {
        final page = await client.listAssets(limit: _pageSize, after: cursor);
        if (page.assets.isEmpty) break;
        final ids = page.assets.map((a) => a.id).toList();

        final thumbUrls = await client.assetUrls(ids, variant: "thumb");
        var previewUrls = <String, String>{};
        if (previews < _maxPreviews) {
          final take = (_maxPreviews - previews).clamp(0, ids.length);
          previewUrls =
              await client.assetUrls(ids.take(take).toList(), variant: "preview");
        }

        await cache.upsertAll(page.assets, thumbs: thumbUrls, previews: previewUrls);
        for (final a in page.assets) {
          final t = thumbUrls[a.id];
          if (t != null) {
            await OfflineCache.warm(OfflineCache.thumbs, a.id, t);
            thumbs++;
          }
          final pv = previewUrls[a.id];
          if (pv != null) {
            await OfflineCache.warm(OfflineCache.previews, a.id, pv);
            previews++;
          }
        }

        cursor = page.nextCursor;
        if (cursor == null) break;
        // Stop if the connection degraded mid-pass (Wi-Fi dropped / metered).
        if (await SyncService.transferableNow() != TransferState.ok) break;
      }
    } catch (_) {
      // Best-effort — partial progress is still useful offline.
    } finally {
      client.close();
      _running = false;
    }
  }
}
