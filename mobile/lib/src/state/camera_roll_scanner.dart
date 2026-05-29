// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Queries the device media store for photos/videos created since the last
// import timestamp and enqueues each new asset into the upload queue.
//
// Designed to be called from both foreground (HomeScreen.initState) and
// the Workmanager background isolate. Permission is checked but never
// requested here — the SettingsScreen is responsible for requesting it
// before auto-import is enabled.

import "package:photo_manager/photo_manager.dart";

import "settings_store.dart";
import "upload_queue.dart";

class CameraRollScanner {
  /// Scans for new camera-roll assets and enqueues them.
  ///
  /// [virtualPath] is the Fonto folder they land in.
  /// Returns the count of newly enqueued items (0 if not permitted or nothing
  /// new). Updates [SettingsStore.lastImportTs] on completion.
  static Future<int> scanAndEnqueue({String virtualPath = "/"}) async {
    // Proceed on full OR limited access. Android 14's "Selected photos"
    // grants PermissionState.limited (isAuth == false) — gating on isAuth
    // silently imported nothing for those users.
    final perm = await PhotoManager.requestPermissionExtend();
    if (!perm.hasAccess) return 0;

    final lastTs = await SettingsStore.getLastImportTs();
    final lastImport =
        lastTs == 0 ? DateTime(2000) : DateTime.fromMillisecondsSinceEpoch(lastTs);
    final now = DateTime.now();

    final albums = await PhotoManager.getAssetPathList(
      type: RequestType.common,
      filterOption: FilterOptionGroup(
        createTimeCond: DateTimeCond(
          min: lastImport,
          max: now,
        ),
      ),
    );

    if (albums.isEmpty) {
      await SettingsStore.setLastImportTs(now.millisecondsSinceEpoch);
      return 0;
    }

    // Folder selection: when the user has picked specific albums, scan exactly
    // those; otherwise default to the "all" album so we don't double-count
    // assets that live in multiple sub-albums. (Cross-album duplicates from a
    // multi-select are deduped downstream by sha256, so enqueue is idempotent.)
    final selectedIds = await SettingsStore.getSelectedAlbumIds();
    final List<AssetPathEntity> targetAlbums;
    if (selectedIds.isEmpty) {
      targetAlbums = [
        albums.firstWhere((a) => a.isAll, orElse: () => albums.first),
      ];
    } else {
      targetAlbums =
          albums.where((a) => selectedIds.contains(a.id)).toList();
    }

    final queue = await UploadQueue.open();
    var enqueued = 0;

    for (final album in targetAlbums) {
      final count = await album.assetCountAsync;
      if (count <= 0) continue;
      final entities = await album.getAssetListRange(start: 0, end: count);
      for (final entity in entities) {
        final file = await entity.originFile;
        if (file == null) continue;
        final hash = await UploadQueue.hashFile(file);
        final id = await queue.enqueue(
          filePath: file.path,
          virtualPath: virtualPath,
          sha256Hex: hash,
        );
        if (id != null) enqueued++;
      }
    }

    // Advance the watermark only after a full pass, so an interrupted scan
    // re-tries next time (dedupe by sha256 makes re-enqueue a no-op).
    await SettingsStore.setLastImportTs(now.millisecondsSinceEpoch);
    return enqueued;
  }
}
