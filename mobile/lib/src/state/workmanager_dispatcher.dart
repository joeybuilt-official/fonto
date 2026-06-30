// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Top-level Workmanager callback. Runs in its own isolate on:
//   - Android: WorkManager periodic / one-off tasks
//   - iOS:     BGProcessingTask / BGAppRefreshTask (when the OS grants
//              opportunity, which is conservative — every few hours)
//
// MUST be a top-level function (Workmanager constraint — the engine
// looks it up by name across the isolate boundary). Keep it minimal:
// initialize Flutter bindings, drain the queue, return.

import "package:flutter/widgets.dart";
import "package:flutter_local_notifications/flutter_local_notifications.dart";
import "package:workmanager/workmanager.dart";

import "camera_roll_scanner.dart";
import "drive_download_queue.dart";
import "settings_store.dart";
import "upload_queue.dart";

export "drive_download_queue.dart" show kDriveDownloadTask;

const kUploadDrainTask = "fonto.uploadDrain";
const kCameraRollScanTask = "fonto.cameraRollScan";

const _kNotifId = 43;
const _kNotifChannelId = "fonto_drive_import";

@pragma("vm:entry-point")
void callbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    WidgetsFlutterBinding.ensureInitialized();
    try {
      if (task == kUploadDrainTask || task == Workmanager.iOSBackgroundTask) {
        await UploadQueue.drain();
        return true;
      }
      if (task == kCameraRollScanTask) {
        final enabled = await SettingsStore.getAutoImport();
        if (enabled) {
          // Scan and drain are wrapped separately so a drain failure never
          // rolls back the scan's watermark advance, and a scan failure (which
          // leaves the watermark untouched, see CameraRollScanner) is logged on
          // its own phase. A throwing scan returns false so WorkManager retries.
          try {
            await CameraRollScanner.scanAndEnqueue();
          } catch (e) {
            debugPrint("cameraRollScan phase failed: $e");
            return false;
          }
          try {
            await UploadQueue.drain();
          } catch (e) {
            debugPrint("uploadDrain phase failed: $e");
            return false;
          }
        }
        return true;
      }
      if (task == kDriveDownloadTask) {
        final notif = FlutterLocalNotificationsPlugin();
        await notif.initialize(
          const InitializationSettings(
            android: AndroidInitializationSettings("@mipmap/ic_launcher"),
          ),
        );
        await notif.show(
          _kNotifId,
          "Fonto",
          "Downloading Drive files in the background…",
          const NotificationDetails(
            android: AndroidNotificationDetails(
              _kNotifChannelId,
              "Drive Import",
              channelDescription: "Background Google Drive import progress",
              importance: Importance.low,
              priority: Priority.low,
              ongoing: true,
              playSound: false,
              enableVibration: false,
            ),
          ),
        );
        try {
          await DriveDownloadQueue.processFromBackground();
        } finally {
          await notif.cancel(_kNotifId);
        }
        return true;
      }
    } catch (_) {
      return false;
    }
    return true;
  });
}
