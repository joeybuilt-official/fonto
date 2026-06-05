// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Background sync foreground service. Android throttles WorkManager (Doze /
// App-Standby), so a large camera-roll backup or Drive import would stall the
// moment the app left the foreground. A foreground service (persistent
// notification) is the Android-sanctioned way to keep user-initiated work
// running with the app backgrounded or closed.
//
// The service drains BOTH queues on a timer: Drive downloads (which feed the
// upload queue) and uploads. It self-stops once both are empty. It must be
// STARTED while the app is in the foreground — Android forbids starting a
// dataSync foreground service from the background on API 31+ — so callers kick
// SyncService.ensureRunning() from the home screen / import flow.

import "package:flutter/foundation.dart";
import "package:flutter_foreground_task/flutter_foreground_task.dart";

import "drive_download_queue.dart";
import "upload_queue.dart";

const _kChannelId = "fonto_sync";
const _kServiceId = 4096;

/// Entry point for the foreground-service isolate. Must be top-level + marked
/// vm:entry-point so the AOT compiler keeps it.
@pragma("vm:entry-point")
void startSyncCallback() {
  FlutterForegroundTask.setTaskHandler(_SyncTaskHandler());
}

class _SyncTaskHandler extends TaskHandler {
  bool _busy = false;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    await _tick();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    _tick();
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {}

  /// One drain pass. Re-entrancy guarded so a long drain isn't re-entered by
  /// the next timer tick. Drive downloads run first (they feed the upload
  /// queue), then uploads. Stops the service when nothing remains.
  Future<void> _tick() async {
    if (_busy) return;
    _busy = true;
    try {
      await DriveDownloadQueue.processForeground();
      await UploadQueue.drain();

      final remaining = await _pendingTotal();
      if (remaining == 0) {
        await FlutterForegroundTask.stopService();
      } else {
        FlutterForegroundTask.updateService(
          notificationTitle: "Fonto sync",
          notificationText: "Syncing — $remaining item(s) left",
        );
      }
    } catch (_) {
      // Keep the service alive; the next tick retries.
    } finally {
      _busy = false;
    }
  }
}

Future<int> _pendingTotal() async {
  final driveQ = await DriveDownloadQueue.open();
  final uploadQ = await UploadQueue.open();
  final drive = await driveQ.pendingCount();
  final upload = await uploadQ.pendingCount();
  return drive + upload;
}

class SyncService {
  static bool _inited = false;

  /// Configure the notification channel + task options once. Call after
  /// FlutterForegroundTask.initCommunicationPort() in main().
  static void init() {
    if (_inited) return;
    _inited = true;
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: _kChannelId,
        channelName: "Background sync",
        channelDescription:
            "Shown while Fonto uploads photos and imports Drive files.",
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(
        showNotification: false,
        playSound: false,
      ),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.repeat(10000),
        autoRunOnBoot: true,
        autoRunOnMyPackageReplaced: true,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
  }

  /// Start the foreground service if there's pending work and it isn't already
  /// running. Safe to call liberally (no-op when idle / already running). Must
  /// be invoked while the app is foregrounded.
  static Future<void> ensureRunning() async {
    init();
    if (await _pendingTotal() == 0) return;
    if (await FlutterForegroundTask.isRunningService) return;
    final remaining = await _pendingTotal();
    await FlutterForegroundTask.startService(
      serviceId: _kServiceId,
      notificationTitle: "Fonto sync",
      notificationText: "Syncing $remaining item(s)…",
      callback: startSyncCallback,
    );
  }

  static Future<void> stop() async {
    if (await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.stopService();
    }
  }

  // ── Permissions / reliability gates ──────────────────────────────────────

  /// Notifications must be granted for the service notification to show
  /// (Android 13+). The plugin opens the system dialog / settings.
  static Future<bool> hasNotificationPermission() async {
    return (await FlutterForegroundTask.checkNotificationPermission()) ==
        NotificationPermission.granted;
  }

  static Future<void> requestNotificationPermission() async {
    await FlutterForegroundTask.requestNotificationPermission();
  }

  /// When battery optimization is ON, Android still throttles the app — even a
  /// foreground service can be killed under Doze. The exemption is what makes
  /// sync truly reliable in the background.
  static Future<bool> isBatteryOptimizationExempt() async {
    return FlutterForegroundTask.isIgnoringBatteryOptimizations;
  }

  /// Opens the system "ignore battery optimizations" dialog/settings.
  static Future<void> requestBatteryOptimizationExempt() async {
    await FlutterForegroundTask.requestIgnoreBatteryOptimization();
  }

  /// True when both gates are satisfied — used to decide whether to nudge the
  /// user with the permission sheet.
  static Future<bool> isFullyEnabled() async {
    return (await hasNotificationPermission()) &&
        (await isBatteryOptimizationExempt());
  }
}
