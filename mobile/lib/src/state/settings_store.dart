// SPDX-License-Identifier: AGPL-3.0-only
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

  static Future<bool> getAutoImport() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_kAutoImport) ?? false;
  }

  static Future<void> setAutoImport(bool enabled) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kAutoImport, enabled);
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
