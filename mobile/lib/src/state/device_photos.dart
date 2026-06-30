// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Read-only view onto the device camera roll for the offline "On this device"
// section of the library. Purely local — every call works with no network.
//
// This does NOT own the upload pipeline. Listing recents is paired with
// CameraRollScanner.scanAndEnqueue() (the existing hash + UploadQueue.enqueue
// path) so the same photos the user sees here get queued + drained by the
// existing UploadQueue machinery when connectivity returns.

import "package:photo_manager/photo_manager.dart";

import "settings_store.dart";

class DevicePhotos {
  /// Whether photo access is already granted. Never prompts — the
  /// SettingsScreen / auto-import flow owns the actual permission request, and
  /// HomeScreen only shows the device section when access already exists.
  static Future<bool> hasPermission() async {
    final perm = await PhotoManager.requestPermissionExtend();
    return perm.hasAccess;
  }

  /// Newest device images, local thumbnails only. Returns an empty list when
  /// access isn't granted or there's nothing to show.
  ///
  /// Respects [SettingsStore.getSelectedAlbumIds] when the user has narrowed
  /// auto-import to specific albums; otherwise reads the "all" album. Mirrors
  /// the folder-selection logic in [CameraRollScanner.scanAndEnqueue] so the
  /// previewed set matches what actually gets enqueued.
  static Future<List<AssetEntity>> recent({int limit = 120}) async {
    final perm = await PhotoManager.requestPermissionExtend();
    if (!perm.hasAccess) return const [];

    final selectedIds = await SettingsStore.getSelectedAlbumIds();

    // Newest-first: photo_manager has no implicit order, so the platform
    // default (Android MediaStore ≈ oldest-first) would push the newest photos
    // past the `limit` cap and hide them. Force createDate-descending.
    final newestFirst = FilterOptionGroup(
      orders: [const OrderOption(type: OrderOptionType.createDate, asc: false)],
    );

    if (selectedIds.isEmpty) {
      // Default: the single "all" album, newest-first.
      final paths = await PhotoManager.getAssetPathList(
        type: RequestType.image,
        onlyAll: true,
        filterOption: newestFirst,
      );
      if (paths.isEmpty) return const [];
      return paths.first.getAssetListRange(start: 0, end: limit);
    }

    // Specific albums chosen — pull from each (newest-first) until we hit the
    // limit, deduping by asset id since one photo can live in several albums.
    final paths = await PhotoManager.getAssetPathList(
      type: RequestType.image,
      filterOption: newestFirst,
    );
    final selected =
        paths.where((p) => selectedIds.contains(p.id)).toList();
    final seen = <String>{};
    final out = <AssetEntity>[];
    for (final album in selected) {
      if (out.length >= limit) break;
      final remaining = limit - out.length;
      final batch = await album.getAssetListRange(start: 0, end: remaining);
      for (final e in batch) {
        if (seen.add(e.id)) out.add(e);
      }
    }
    return out;
  }
}
