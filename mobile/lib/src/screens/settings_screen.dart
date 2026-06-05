// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Settings screen — pushed from the avatar PopupMenu on HomeScreen.
// Currently exposes a single toggle: "Auto-import camera roll". When
// enabled, WorkManager schedules a periodic scan and the HomeScreen
// runs a foreground scan on each launch.

import "package:flutter/material.dart";
import "package:photo_manager/photo_manager.dart";
import "package:workmanager/workmanager.dart";

import "../api/fonto_client.dart";
import "../state/auth_store.dart";
import "../state/camera_roll_scanner.dart";
import "../state/settings_store.dart";
import "../state/sync_service.dart";
import "../state/upload_queue.dart";
import "../state/workmanager_dispatcher.dart";
import "../widgets/sync_permission_sheet.dart";
import "google_drive_import_screen.dart";
import "nextcloud_import_screen.dart";

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _loading = true;
  bool _autoImport = false;
  bool _wifiOnly = false;
  int _lastImportTs = 0;
  bool _scanning = false;
  bool _reprocessing = false;
  List<String> _selectedAlbumIds = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final enabled = await SettingsStore.getAutoImport();
    final ts = await SettingsStore.getLastImportTs();
    final albums = await SettingsStore.getSelectedAlbumIds();
    final wifiOnly = await SettingsStore.getSyncWifiOnly();
    if (!mounted) return;
    setState(() {
      _autoImport = enabled;
      _lastImportTs = ts;
      _selectedAlbumIds = albums;
      _wifiOnly = wifiOnly;
      _loading = false;
    });
  }

  Future<void> _onWifiOnlyToggle(bool value) async {
    await SettingsStore.setSyncWifiOnly(value);
    if (mounted) setState(() => _wifiOnly = value);
    // Re-apply the network constraint to the WorkManager backstop tasks so the
    // setting is honoured in the background too (unmetered vs any connection).
    final netType = value ? NetworkType.unmetered : NetworkType.connected;
    await Workmanager().registerPeriodicTask(
      kUploadDrainTask,
      kUploadDrainTask,
      frequency: const Duration(minutes: 15),
      constraints: Constraints(networkType: netType),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.replace,
    );
    if (await SettingsStore.getAutoImport()) {
      await Workmanager().cancelByUniqueName(kCameraRollScanTask);
      await Workmanager().registerPeriodicTask(
        kCameraRollScanTask,
        kCameraRollScanTask,
        frequency: const Duration(minutes: 30),
        constraints: Constraints(
          networkType: value ? NetworkType.unmetered : NetworkType.connected,
        ),
        existingWorkPolicy: ExistingPeriodicWorkPolicy.replace,
      );
    }
  }

  Future<void> _pickFolders() async {
    final perm = await PhotoManager.requestPermissionExtend();
    if (!mounted) return;
    if (!perm.hasAccess) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            "Photo access is required to choose folders. "
            "Enable it in device Settings → Permissions.",
          ),
        ),
      );
      return;
    }
    final albums =
        await PhotoManager.getAssetPathList(type: RequestType.common);
    if (!mounted) return;
    final working = {..._selectedAlbumIds};
    final result = await showDialog<List<String>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text("Folders to import"),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView(
              shrinkWrap: true,
              children: [
                CheckboxListTile(
                  title: const Text("Select all"),
                  // Checked only when every folder is selected. Tapping it
                  // ticks (or clears) every folder checkbox below — the old
                  // "All folders" row meant all-via-empty and left the
                  // individual boxes unchecked, which read as broken.
                  value:
                      albums.isNotEmpty && albums.every((a) => working.contains(a.id)),
                  onChanged: (v) => setLocal(() {
                    working.clear();
                    if (v == true) {
                      for (final a in albums) {
                        working.add(a.id);
                      }
                    }
                  }),
                ),
                const Divider(height: 1),
                ...albums.map(
                  (a) => CheckboxListTile(
                    title: Text(a.isAll ? "All photos" : a.name),
                    value: working.contains(a.id),
                    onChanged: (v) => setLocal(() {
                      if (v == true) {
                        working.add(a.id);
                      } else {
                        working.remove(a.id);
                      }
                    }),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text("Cancel"),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(working.toList()),
              child: const Text("Save"),
            ),
          ],
        ),
      ),
    );
    if (result == null || !mounted) return;
    await SettingsStore.setSelectedAlbumIds(result);
    if (mounted) setState(() => _selectedAlbumIds = result);
  }

  String _folderSummary() {
    if (_selectedAlbumIds.isEmpty) return "All folders on this device";
    final n = _selectedAlbumIds.length;
    return "$n folder${n == 1 ? "" : "s"} selected";
  }

  Future<void> _onToggle(bool value) async {
    if (value) {
      final perm = await PhotoManager.requestPermissionExtend();
      if (!mounted) return;
      if (!perm.isAuth) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              "Photo access is required for auto-import. "
              "Enable it in device Settings → Permissions.",
            ),
          ),
        );
        return;
      }
      await SettingsStore.setAutoImport(true);
      await Workmanager().registerPeriodicTask(
        kCameraRollScanTask,
        kCameraRollScanTask,
        frequency: const Duration(minutes: 30),
        constraints: Constraints(
          // Backstop only; the foreground service does the real draining.
          networkType: NetworkType.connected,
        ),
        existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
      );
      if (mounted) setState(() => _autoImport = true);
      // Nudge the user to grant the reliability gates so backups continue in
      // the background.
      if (mounted) await SyncPermissionSheet.maybePrompt(context);
    } else {
      await SettingsStore.setAutoImport(false);
      await Workmanager().cancelByUniqueName(kCameraRollScanTask);
      if (mounted) setState(() => _autoImport = false);
    }
  }

  Future<void> _scanNow() async {
    setState(() => _scanning = true);
    try {
      final n = await CameraRollScanner.scanAndEnqueue();
      if (!mounted) return;
      final ts = await SettingsStore.getLastImportTs();
      setState(() {
        _lastImportTs = ts;
        _scanning = false;
      });
      if (n > 0) {
        await SyncService.ensureRunning();
        await UploadQueue.drain();
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              n == 0 ? "Nothing new to import." : "Queued $n item(s) for upload.",
            ),
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _scanning = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Scan failed: $e")),
      );
    }
  }

  String _formatTs(int ts) {
    if (ts == 0) return "Never";
    final dt = DateTime.fromMillisecondsSinceEpoch(ts).toLocal();
    return "${dt.year}-${_z(dt.month)}-${_z(dt.day)} "
        "${_z(dt.hour)}:${_z(dt.minute)}";
  }

  String _z(int n) => n.toString().padLeft(2, "0");

  Future<void> _reprocessAll() async {
    final scope = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  "Re-scan which assets?",
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.all_inclusive),
              title: const Text("All assets"),
              onTap: () => Navigator.of(ctx).pop("all"),
            ),
            ListTile(
              leading: const Icon(Icons.image_outlined),
              title: const Text("Images only"),
              onTap: () => Navigator.of(ctx).pop("images"),
            ),
            ListTile(
              leading: const Icon(Icons.error_outline),
              title: const Text("Failed / unprocessed"),
              onTap: () => Navigator.of(ctx).pop("failed"),
            ),
          ],
        ),
      ),
    );
    if (scope == null || !mounted) return;
    setState(() => _reprocessing = true);
    try {
      final auth = await AuthStore.load();
      if (!auth.isConfigured) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Sign in first to re-scan.")),
          );
        }
        return;
      }
      final client = FontoClient(auth);
      try {
        final n = await client.reprocessWorkspace(scope: scope);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Queued $n asset${n == 1 ? "" : "s"} for re-scan.")),
        );
      } finally {
        client.close();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Re-scan failed: $e")),
        );
      }
    } finally {
      if (mounted) setState(() => _reprocessing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Settings")),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              children: [
                SwitchListTile(
                  title: const Text("Auto-import camera roll"),
                  subtitle: const Text(
                    "New photos and videos taken on this device are "
                    "automatically uploaded to Fonto.",
                  ),
                  value: _autoImport,
                  onChanged: _onToggle,
                ),
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: Text(
                    "Import is one-way: Fonto copies your photos and never "
                    "moves, changes, or deletes the originals on your device.",
                    style: TextStyle(fontSize: 12),
                  ),
                ),
                if (_autoImport)
                  ListTile(
                    title: const Text("Folders to import"),
                    subtitle: Text(_folderSummary()),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _pickFolders,
                  ),
                if (_autoImport)
                  ListTile(
                    title: const Text("Last import"),
                    subtitle: Text(_formatTs(_lastImportTs)),
                    trailing: _scanning
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : IconButton(
                            icon: const Icon(Icons.sync),
                            tooltip: "Scan now",
                            onPressed: _scanNow,
                          ),
                  ),
                SwitchListTile(
                  secondary: const Icon(Icons.wifi),
                  title: const Text("Sync on Wi-Fi only"),
                  subtitle: const Text(
                    "Pause uploads and Drive imports on mobile data to save "
                    "data and battery.",
                  ),
                  value: _wifiOnly,
                  onChanged: _onWifiOnlyToggle,
                ),
                ListTile(
                  leading: const Icon(Icons.cloud_sync_outlined),
                  title: const Text("Background sync"),
                  subtitle: const Text(
                    "Allow uploads and Drive imports to keep running when the "
                    "app is closed.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => SyncPermissionSheet.show(context),
                ),
                const Divider(),
                ListTile(
                  title: const Text("Re-scan recognition (AI)"),
                  subtitle: const Text(
                    "Re-run OCR, object/scene labels, descriptions, and face "
                    "detection across your library.",
                  ),
                  trailing: _reprocessing
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.auto_awesome_outlined),
                  onTap: _reprocessing ? null : _reprocessAll,
                ),
                const Divider(),
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text(
                    "IMPORT SOURCES",
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.8,
                    ),
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: Text(
                    "Bring assets in from cloud storage. Quick adds (camera, "
                    "scan, gallery) live on the Home + button.",
                    style: TextStyle(fontSize: 12),
                  ),
                ),
                ListTile(
                  leading: const Icon(Icons.folder_outlined),
                  title: const Text("Google Drive"),
                  subtitle:
                      const Text("Browse Drive and import selected files."),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) =>
                          const GoogleDriveImportScreen(virtualPath: "/"),
                    ),
                  ),
                ),
                ListTile(
                  leading: const Icon(Icons.cloud_outlined),
                  title: const Text("Nextcloud"),
                  subtitle: const Text(
                    "Connect a Nextcloud server and import files.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) =>
                          const NextcloudImportScreen(virtualPath: "/"),
                    ),
                  ),
                ),
                ListTile(
                  leading: Icon(
                    Icons.photo_library_outlined,
                    color: Theme.of(context).disabledColor,
                  ),
                  title: Text(
                    "Google Photos",
                    style: TextStyle(color: Theme.of(context).disabledColor),
                  ),
                  subtitle: const Text(
                    "Temporarily unavailable. Google retired the read scope "
                    "third-party apps used (Mar 2025); coming back via the "
                    "new Picker API.",
                  ),
                  enabled: false,
                  onTap: null,
                ),
              ],
            ),
    );
  }
}
