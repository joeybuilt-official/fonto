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
import "package:workmanager/workmanager.dart";

import "camera_roll_scanner.dart";
import "settings_store.dart";
import "upload_queue.dart";

const kUploadDrainTask = "fonto.uploadDrain";
const kCameraRollScanTask = "fonto.cameraRollScan";

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
          await CameraRollScanner.scanAndEnqueue();
          await UploadQueue.drain();
        }
        return true;
      }
    } catch (_) {
      return false;
    }
    return true;
  });
}
