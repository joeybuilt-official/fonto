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

import "../state/camera_roll_scanner.dart";
import "../state/settings_store.dart";
import "../state/upload_queue.dart";
import "../state/workmanager_dispatcher.dart";

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _loading = true;
  bool _autoImport = false;
  int _lastImportTs = 0;
  bool _scanning = false;
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
    if (!mounted) return;
    setState(() {
      _autoImport = enabled;
      _lastImportTs = ts;
      _selectedAlbumIds = albums;
      _loading = false;
    });
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
                  title: const Text("All folders"),
                  value: working.isEmpty,
                  onChanged: (_) => setLocal(working.clear),
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
          networkType: NetworkType.connected,
          requiresBatteryNotLow: true,
        ),
        existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
      );
      if (mounted) setState(() => _autoImport = true);
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
      if (n > 0) await UploadQueue.drain();
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
              ],
            ),
    );
  }
}
