// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Prefetch of the recent library for offline use. Two distinct phases:
//
//   1. METADATA — walk the newest assets + collections and persist their rows
//      (+ last-known signed thumb/preview URLs) to SQLite. Tiny payloads, so
//      this runs whenever we're ONLINE, regardless of the "Wi-Fi only" setting.
//      Without it the offline grid / collections start blank, which is the bug
//      that made "no internet = no content".
//
//   2. IMAGE WARM — download the actual thumbnail (and a shallower window of
//      preview) bytes into the on-device image caches. These are heavy, so this
//      phase still respects the Wi-Fi-only / transferable gate.
//
// Best-effort + bounded: caps how much it pulls (well within the OfflineCache
// object budgets), re-checks connectivity, and never throws into the caller.
// Idempotent — re-runs upsert the same id keys, so it's safe to call repeatedly
// (on boot + on every reconnect / resume).

import "dart:async";

import "package:connectivity_plus/connectivity_plus.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "auth_store.dart";
import "asset_cache.dart";
import "collection_cache.dart";
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

  /// Kick a prefetch pass. Safe to call unawaited on app start AND on every
  /// reconnect/resume — idempotent upserts. No-op if a pass is already running
  /// or we're entirely offline. The metadata phase ignores the Wi-Fi-only
  /// setting (payloads are tiny); only the image-warming phase honours it.
  static Future<void> run(AuthStore auth) async {
    if (_running || !auth.isConfigured) return;
    if (!await _online()) return;
    _running = true;
    final client = FontoClient(auth);
    try {
      // Whether we're allowed to spend bytes warming images right now.
      final warmImages =
          await SyncService.transferableNow() == TransferState.ok;

      // ── Phase 1: metadata (always, when online) ──────────────────────────
      await _persistCollections(client);

      final cache = await AssetCache.open();
      AssetCursor? cursor;
      var thumbs = 0;
      var previews = 0;
      while (thumbs < _maxThumbs) {
        final page = await client.listAssets(limit: _pageSize, after: cursor);
        if (page.assets.isEmpty) break;
        final ids = page.assets.map((a) => a.id).toList();

        // Signed URLs are cheap (metadata): fetch even off-Wi-Fi so the
        // cached rows carry a thumb/preview URL the offline grid can render.
        final thumbUrls = await client.assetUrls(ids, variant: "thumb");
        var previewUrls = <String, String>{};
        if (previews < _maxPreviews) {
          final take = (_maxPreviews - previews).clamp(0, ids.length);
          previewUrls = await client
              .assetUrls(ids.take(take).toList(), variant: "preview");
        }

        await cache.upsertAll(page.assets,
            thumbs: thumbUrls, previews: previewUrls);

        // ── Phase 2: image warm (Wi-Fi/transfer gated) ────────────────────
        if (warmImages) {
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
        } else {
          // Still count toward the metadata page budget so we keep paging the
          // newest window even when we're not warming bytes.
          thumbs += thumbUrls.length;
          previews += previewUrls.length;
        }

        cursor = page.nextCursor;
        if (cursor == null) break;
        // Drop out if we lost connectivity entirely mid-pass.
        if (!await _online()) break;
      }
    } catch (_) {
      // Best-effort — partial progress is still useful offline.
    } finally {
      client.close();
      _running = false;
    }
  }

  /// Persist the collection list so the Collections tab renders offline.
  /// Best-effort: a failure here must not abort the asset metadata phase.
  static Future<void> _persistCollections(FontoClient client) async {
    try {
      final cols = await client.listCollections();
      final cache = await CollectionCache.open();
      await cache.upsertAll(cols);
    } catch (_) {
      // Non-fatal.
    }
  }

  static Future<bool> _online() async {
    final results = await Connectivity().checkConnectivity();
    return results.any((r) => r != ConnectivityResult.none);
  }
}
