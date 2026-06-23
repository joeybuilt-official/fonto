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

import "package:battery_plus/battery_plus.dart";
import "package:connectivity_plus/connectivity_plus.dart";
import "package:flutter_foreground_task/flutter_foreground_task.dart";

import "drive_download_queue.dart";
import "settings_store.dart";
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
  // Battery guard: after this many consecutive ticks that make no progress
  // (offline, Wi-Fi-only on cellular, or a transient auth/server failure) we
  // STOP the service instead of holding a wakelock spinning. The durable
  // queues keep the backlog; the WorkManager backstop + the next app launch
  // resume it once conditions are good. At a 15s tick that's ~45s of grace.
  int _idleTicks = 0;
  static const _maxIdleTicks = 3;

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
  /// queue), then uploads. Self-stops when the queue empties or when it can't
  /// make progress (to save battery).
  Future<void> _tick() async {
    if (_busy) return;
    _busy = true;
    try {
      final before = await _pendingTotal();
      if (before == 0) {
        await FlutterForegroundTask.stopService();
        return;
      }

      // Don't burn battery transferring when we shouldn't / can't.
      final transfer = await SyncService.transferableNow();
      if (transfer != TransferState.ok) {
        _idleTicks++;
        final reason = switch (transfer) {
          TransferState.offline => "waiting for connection",
          TransferState.waitingForCharge => "waiting to charge",
          _ => "waiting for Wi-Fi",
        };
        FlutterForegroundTask.updateService(
          notificationTitle: "Fonto sync",
          notificationText: "Paused — $reason ($before left)",
        );
        if (_idleTicks >= _maxIdleTicks) await FlutterForegroundTask.stopService();
        return;
      }

      await DriveDownloadQueue.processForeground();
      await UploadQueue.drain();
      final after = await _pendingTotal();

      if (after == 0) {
        await FlutterForegroundTask.stopService();
        return;
      }
      if (after < before) {
        _idleTicks = 0; // made progress — keep going
        FlutterForegroundTask.updateService(
          notificationTitle: "Fonto sync",
          notificationText: "Syncing — $after item(s) left",
        );
      } else {
        // Usable connection but nothing moved (auth gap / server hiccup):
        // back off rather than spin the radio + CPU.
        _idleTicks++;
        if (_idleTicks >= _maxIdleTicks) await FlutterForegroundTask.stopService();
      }
    } catch (_) {
      // Keep the service alive; the next tick retries.
    } finally {
      _busy = false;
    }
  }
}

/// Whether sync may transfer right now.
enum TransferState { ok, offline, waitingForWifi, waitingForCharge }

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
        // 15s between drain checks — the drains themselves loop internally, so
        // this is just a "still working / conditions still ok?" heartbeat.
        eventAction: ForegroundTaskEventAction.repeat(15000),
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

  /// Whether sync is allowed to transfer right now, honouring the "Wi-Fi only"
  /// setting. Used by the service to pause (and back off) instead of spinning
  /// the radio + CPU on a connection it shouldn't use.
  static Future<TransferState> transferableNow() async {
    final results = await Connectivity().checkConnectivity();
    final online = results.any((r) => r != ConnectivityResult.none);
    if (!online) return TransferState.offline;
    if (await SettingsStore.getSyncWifiOnly()) {
      final unmetered = results.any((r) =>
          r == ConnectivityResult.wifi || r == ConnectivityResult.ethernet);
      if (!unmetered) return TransferState.waitingForWifi;
    }
    if (await SettingsStore.getSyncChargingOnly()) {
      // charging | full both count as "plugged in". Failure to read the battery
      // state falls through to allowing the transfer (fail-open — never trap a
      // backup behind a flaky platform read).
      try {
        final state = await Battery().batteryState;
        if (state != BatteryState.charging && state != BatteryState.full) {
          return TransferState.waitingForCharge;
        }
      } catch (_) {
        // ignore — treat as transferable
      }
    }
    return TransferState.ok;
  }
}
