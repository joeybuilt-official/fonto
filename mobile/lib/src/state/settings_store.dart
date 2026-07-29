// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Lightweight key/value settings backed by SharedPreferences. All reads
// and writes are async but cheap (in-memory cache after first load). Safe
// to call from a Workmanager background isolate after
// WidgetsFlutterBinding.ensureInitialized().

import "package:shared_preferences/shared_preferences.dart";

class SettingsStore {
  static const _kAutoImport = "fonto.auto_import_enabled";
  static const _kLastImportTs = "fonto.last_import_ts";
  static const _kSelectedAlbums = "fonto.selected_album_ids";
  static const _kWifiOnly = "fonto.sync_wifi_only";
  static const _kChargingOnly = "fonto.sync_charging_only";
  static const _kLastSurface = "fonto.last_library_surface";
  static const _kEnqueuedHighWater = "fonto.enqueued_high_water";

  /// Photos-Files split — last-used Library surface ("photos" | "files").
  /// Inbox is never persisted (it is transient triage). Defaults to "photos".
  static Future<String> getLastSurface() async {
    final p = await SharedPreferences.getInstance();
    return p.getString(_kLastSurface) ?? "photos";
  }

  static Future<void> setLastSurface(String surface) async {
    if (surface != "photos" && surface != "files") return;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kLastSurface, surface);
  }

  static Future<bool> getAutoImport() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_kAutoImport) ?? false;
  }

  static Future<void> setAutoImport(bool enabled) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kAutoImport, enabled);
  }

  /// When true, sync only transfers on un-metered (Wi-Fi/ethernet) networks —
  /// saves cellular data + the battery cost of the mobile radio. Default off
  /// so a fresh install still backs up immediately on any connection.
  static Future<bool> getSyncWifiOnly() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_kWifiOnly) ?? false;
  }

  static Future<void> setSyncWifiOnly(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kWifiOnly, value);
  }

  /// When true, sync only transfers while the device is charging — protects
  /// battery on long backlog drains. Default off so a fresh install backs up
  /// immediately regardless of charge state.
  static Future<bool> getSyncChargingOnly() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_kChargingOnly) ?? false;
  }

  static Future<void> setSyncChargingOnly(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kChargingOnly, value);
  }

  /// Epoch milliseconds; 0 when no scan has ever run.
  static Future<int> getLastImportTs() async {
    final p = await SharedPreferences.getInstance();
    return p.getInt(_kLastImportTs) ?? 0;
  }

  static Future<void> setLastImportTs(int epochMs) async {
    final p = await SharedPreferences.getInstance();
    await p.setInt(_kLastImportTs, epochMs);
  }

  /// Highest device image count seen at the end of a completed full reconcile.
  /// A later scan finding a higher device count means assets landed *behind*
  /// the createTime watermark (restored from Google Photos / iCloud / WhatsApp /
  /// AirDrop carry an old createDate), so a full no-watermark reconcile runs.
  /// Default 0 so existing installs auto-backfill on the next scan.
  static Future<int> getEnqueuedHighWater() async {
    final p = await SharedPreferences.getInstance();
    return p.getInt(_kEnqueuedHighWater) ?? 0;
  }

  static Future<void> setEnqueuedHighWater(int count) async {
    final p = await SharedPreferences.getInstance();
    await p.setInt(_kEnqueuedHighWater, count);
  }

  /// Album IDs the user chose to import from. Empty list ⇒ import everything
  /// (the default). Stored as device-local album identifiers from
  /// PhotoManager.
  static Future<List<String>> getSelectedAlbumIds() async {
    final p = await SharedPreferences.getInstance();
    return p.getStringList(_kSelectedAlbums) ?? const [];
  }

  static Future<void> setSelectedAlbumIds(List<String> ids) async {
    final p = await SharedPreferences.getInstance();
    await p.setStringList(_kSelectedAlbums, ids);
  }
}
