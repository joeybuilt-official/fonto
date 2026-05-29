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
    // Only proceed if permission is already granted — never prompt here.
    final perm = await PhotoManager.requestPermissionExtend();
    if (!perm.isAuth) return 0;

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

    await SettingsStore.setLastImportTs(now.millisecondsSinceEpoch);

    if (albums.isEmpty) return 0;

    // Prefer the "all" album so we don't double-count assets in sub-albums.
    final album = albums.firstWhere(
      (a) => a.isAll,
      orElse: () => albums.first,
    );

    final count = await album.assetCountAsync;
    if (count == 0) return 0;

    final entities = await album.getAssetListRange(start: 0, end: count);
    final queue = await UploadQueue.open();
    var enqueued = 0;

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

    return enqueued;
  }
}
