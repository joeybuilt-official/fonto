// SPDX-License-Identifier: MIT
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
  /// Minimum spacing between full-library reconciles. Without this throttle a
  /// single new photo keeps `deviceCount > highWater` true, so every scan would
  /// drop the createTime window and re-hash (read every byte of) the ENTIRE
  /// library — every photo AND video — draining battery on a daily shooter.
  static const _reconcileMinInterval = Duration(days: 7);

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

    // Full-library reconcile: photos restored from Google Photos / iCloud /
    // WhatsApp / AirDrop carry an OLD createDate, so they sort *behind* the
    // createTime watermark and would never be enqueued. When the device's total
    // image count exceeds the stored high-water, drop the createTimeCond and
    // re-scan everything; enqueue is sha256-idempotent so already-uploaded
    // assets are skipped downstream (also auto-backfills existing installs).
    // Cost ceiling: a count mismatch re-hashes the full library this pass.
    final deviceCount = await PhotoManager.getAssetCount(type: RequestType.common);
    final highWater = await SettingsStore.getEnqueuedHighWater();
    // Throttle the full reconcile: only re-hash the whole library when the
    // device gained assets AND we haven't reconciled within the last window.
    // Otherwise a single new photo (deviceCount > highWater on every scan)
    // triggers a full-library byte re-hash each pass. The cheap createTime
    // window below still catches ordinary new photos between reconciles; the
    // reconcile exists only to backfill restores that carry an OLD createDate.
    final lastReconcileTs = await SettingsStore.getLastReconcileTs();
    final reconcileDue = lastReconcileTs == 0 ||
        now.millisecondsSinceEpoch - lastReconcileTs >=
            _reconcileMinInterval.inMilliseconds;
    final reconcile = deviceCount > highWater && reconcileDue;

    final albums = await PhotoManager.getAssetPathList(
      type: RequestType.common,
      filterOption: reconcile
          ? FilterOptionGroup()
          : FilterOptionGroup(
              createTimeCond: DateTimeCond(
                min: lastImport,
                max: now,
              ),
            ),
    );

    if (albums.isEmpty) {
      // No album scanned to completion (empty list / permission downgrade) —
      // do NOT advance the watermark, so the next pass retries.
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
    // Oldest asset skipped because its originFile was unavailable (iCloud not
    // downloaded / HEIC pending). The watermark is clamped behind it so the
    // next pass retries those assets instead of stepping over them.
    DateTime? oldestSkipped;

    for (final album in targetAlbums) {
      final count = await album.assetCountAsync;
      if (count <= 0) continue;
      final entities = await album.getAssetListRange(start: 0, end: count);
      for (final entity in entities) {
        final file = await entity.originFile;
        if (file == null) {
          final created = entity.createDateTime;
          if (oldestSkipped == null || created.isBefore(oldestSkipped)) {
            oldestSkipped = created;
          }
          continue;
        }
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
    // re-tries next time (dedupe by sha256 makes re-enqueue a no-op). Clamp it
    // just behind the oldest skipped (originFile==null) asset so those retry.
    var watermark = now;
    if (oldestSkipped != null &&
        oldestSkipped.isBefore(watermark)) {
      watermark = oldestSkipped.subtract(const Duration(milliseconds: 1));
    }
    await SettingsStore.setLastImportTs(watermark.millisecondsSinceEpoch);
    if (reconcile) {
      await SettingsStore.setEnqueuedHighWater(deviceCount);
      await SettingsStore.setLastReconcileTs(now.millisecondsSinceEpoch);
    }
    return enqueued;
  }
}
