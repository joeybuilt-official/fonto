// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Settings screen — pushed from the avatar PopupMenu on HomeScreen.
// Currently exposes a single toggle: "Auto-import camera roll". When
// enabled, WorkManager schedules a periodic scan and the HomeScreen
// runs a foreground scan on each launch.

import "package:flutter/material.dart";
import "package:photo_manager/photo_manager.dart";
import "package:url_launcher/url_launcher.dart";
import "package:workmanager/workmanager.dart";

import "../../main.dart" show loadThemeMode, saveThemeMode;
import "../api/fonto_client.dart";
import "../api/models.dart";
import "../state/auth_store.dart";
import "../state/camera_roll_scanner.dart";
import "../state/settings_store.dart";
import "../state/sync_service.dart";
import "../state/upload_queue.dart";
import "../state/workmanager_dispatcher.dart";
import "../services/zip_export.dart";
import "../widgets/sync_permission_sheet.dart";
import "admin_screen.dart";
import "google_drive_import_screen.dart";
import "imports_screen.dart";
import "nextcloud_import_screen.dart";
import "google_photos_import_screen.dart";
import "transfers_screen.dart";

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, this.auth, this.onSignOut});

  /// Present ⇒ the Account section renders (manage-account link + sign out).
  /// Absent (e.g. a standalone push) ⇒ the section is hidden.
  final AuthStore? auth;
  final VoidCallback? onSignOut;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _loading = true;
  ThemeMode _themeMode = ThemeMode.system;
  bool _autoImport = false;
  bool _wifiOnly = false;
  bool _chargingOnly = false;
  int _lastImportTs = 0;
  bool _scanning = false;
  bool _reprocessing = false;
  List<String> _selectedAlbumIds = const [];
  // Phase B6 (storage placement) — workspace policy + mirror coverage.
  StoragePlacement? _storage;
  bool _policyBusy = false;

  // Inline account identity (P2) — name/email from GET /api/v1/me. null while
  // loading; _accountError set when the fetch fails.
  AccountInfo? _account;
  bool _accountLoading = false;
  bool _accountError = false;

  @override
  void initState() {
    super.initState();
    _load();
    _loadStorage();
    _loadAdmin();
    _loadAccount();
  }

  Future<void> _loadAccount() async {
    if (widget.auth == null) return;
    setState(() {
      _accountLoading = true;
      _accountError = false;
    });
    try {
      final auth = await AuthStore.load();
      final client = FontoClient(auth);
      try {
        final a = await client.me();
        if (mounted) setState(() => _account = a);
      } finally {
        client.close();
      }
    } catch (_) {
      if (mounted) setState(() => _accountError = true);
    } finally {
      if (mounted) setState(() => _accountLoading = false);
    }
  }

  // M14 / ADR 0055 — gate the Instance Admin tile on the server tier check.
  bool _isAdmin = false;
  Future<void> _loadAdmin() async {
    try {
      final auth = await AuthStore.load();
      final client = FontoClient(auth);
      try {
        final ok = await client.adminMe();
        if (mounted) setState(() => _isAdmin = ok);
      } finally {
        client.close();
      }
    } catch (_) {
      // Best-effort — tile stays hidden on failure (fail-closed).
    }
  }

  Future<void> _openAdmin() async {
    final auth = await AuthStore.load();
    if (!mounted) return;
    final client = FontoClient(auth);
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => AdminScreen(client: client)),
    );
    client.close();
  }

  Future<void> _loadStorage() async {
    try {
      final auth = await AuthStore.load();
      final client = FontoClient(auth);
      try {
        final s = await client.storagePlacement();
        if (mounted) setState(() => _storage = s);
      } finally {
        client.close();
      }
    } catch (_) {
      // Best-effort — the section just stays hidden if the fetch fails.
    }
  }

  Future<void> _onPolicyChange(String? next) async {
    final current = _storage;
    if (next == null || current == null || _policyBusy || next == current.policy) {
      return;
    }
    setState(() => _policyBusy = true);
    try {
      final auth = await AuthStore.load();
      final client = FontoClient(auth);
      try {
        await client.setStoragePolicy(next);
      } finally {
        client.close();
      }
      await _loadStorage();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              next == "mirror"
                  ? "New uploads now mirror to NAS. Existing assets backfill in the background."
                  : "New uploads are stored in the cloud only.",
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Couldn't change storage: $e")),
        );
      }
    } finally {
      if (mounted) setState(() => _policyBusy = false);
    }
  }

  // Inline account row: avatar + name/email. Loading spinner while fetching,
  // a retry affordance on error, and a graceful "Signed in" fallback when the
  // profile has neither name nor email.
  Widget _buildAccountIdentity() {
    final a = _account;
    if (a != null) {
      final name = (a.name != null && a.name!.trim().isNotEmpty)
          ? a.name!.trim()
          : (a.email ?? "Signed in");
      return ListTile(
        leading: const Icon(Icons.person_outline),
        title: Text(name),
        subtitle: (a.email != null && a.email!.trim().isNotEmpty)
            ? Text(a.email!.trim())
            : null,
      );
    }
    if (_accountError) {
      return ListTile(
        leading: const Icon(Icons.person_outline),
        title: const Text("Couldn't load account"),
        subtitle: const Text("Tap to retry."),
        trailing: const Icon(Icons.refresh),
        onTap: _accountLoading ? null : _loadAccount,
      );
    }
    return const ListTile(
      leading: Icon(Icons.person_outline),
      title: Text("Loading account…"),
      trailing: SizedBox(
        width: 18,
        height: 18,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    );
  }

  String _fmtBytes(int bytes) {
    if (bytes < 1024) return "$bytes B";
    if (bytes < 1024 * 1024) return "${(bytes / 1024).toStringAsFixed(1)} KB";
    if (bytes < 1024 * 1024 * 1024) {
      return "${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB";
    }
    return "${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB";
  }

  Future<void> _load() async {
    final enabled = await SettingsStore.getAutoImport();
    final ts = await SettingsStore.getLastImportTs();
    final albums = await SettingsStore.getSelectedAlbumIds();
    final wifiOnly = await SettingsStore.getSyncWifiOnly();
    final chargingOnly = await SettingsStore.getSyncChargingOnly();
    final themeMode = await loadThemeMode();
    if (!mounted) return;
    setState(() {
      _autoImport = enabled;
      _lastImportTs = ts;
      _selectedAlbumIds = albums;
      _wifiOnly = wifiOnly;
      _chargingOnly = chargingOnly;
      _themeMode = themeMode;
      _loading = false;
    });
  }

  Future<void> _onThemeChange(ThemeMode? next) async {
    if (next == null || next == _themeMode) return;
    setState(() => _themeMode = next);
    // Applies live (MaterialApp listens to the same notifier) and persists.
    await saveThemeMode(next);
  }

  // Change password / edit profile live on the web account page; open it in the
  // system browser. Better Auth's session cookie carries over, so no re-login.
  Future<void> _openWebAccount() async {
    final base = widget.auth?.baseUrl;
    if (base == null || base.isEmpty) return;
    final uri = Uri.parse("$base/app/settings");
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  void _signOut() {
    // Pop Settings first so the app swaps cleanly to the login screen beneath.
    Navigator.of(context).pop();
    widget.onSignOut?.call();
  }

  String _accountHost() {
    final base = widget.auth?.baseUrl ?? "";
    final host = Uri.tryParse(base)?.host;
    return (host == null || host.isEmpty) ? "the web app" : host;
  }

  /// Re-register the upload-drain backstop with the current network + charging
  /// constraints. Both sync toggles funnel through here so neither clobbers the
  /// other's constraint.
  Future<void> _reRegisterDrain() async {
    await Workmanager().registerPeriodicTask(
      kUploadDrainTask,
      kUploadDrainTask,
      frequency: const Duration(minutes: 15),
      constraints: Constraints(
        networkType: _wifiOnly ? NetworkType.unmetered : NetworkType.connected,
        requiresCharging: _chargingOnly,
      ),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.replace,
    );
  }

  Future<void> _onChargingOnlyToggle(bool value) async {
    await SettingsStore.setSyncChargingOnly(value);
    if (mounted) setState(() => _chargingOnly = value);
    await _reRegisterDrain();
  }

  Future<void> _onWifiOnlyToggle(bool value) async {
    await SettingsStore.setSyncWifiOnly(value);
    if (mounted) setState(() => _wifiOnly = value);
    // Re-apply both constraints to the WorkManager backstop so the setting is
    // honoured in the background too (unmetered vs any connection).
    await _reRegisterDrain();
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

  Future<void> _openImports(String provider) async {
    final auth = await AuthStore.load();
    if (!mounted) return;
    if (!auth.isConfigured) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Sign in first to import.")),
      );
      return;
    }
    final client = FontoClient(auth);
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ImportsScreen(client: client, provider: provider),
      ),
    );
    client.close();
  }

  // M14 / ADR 0057 — export the whole library (manifest + every original) via
  // the M8 streaming-zip pipeline, then hand off to the native share sheet.
  Future<void> _exportLibrary() async {
    final auth = await AuthStore.load();
    if (!mounted) return;
    if (!auth.isConfigured) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Sign in first to export.")),
      );
      return;
    }
    final client = FontoClient(auth);
    try {
      await exportAndShareZip(context, client, scope: "workspace");
    } finally {
      client.close();
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
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text(
                    "APPEARANCE",
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.8,
                    ),
                  ),
                ),
                ListTile(
                  leading: const Icon(Icons.brightness_6_outlined),
                  title: const Text("Theme"),
                  subtitle: const Text(
                    "Match your device, or force light or dark.",
                  ),
                  trailing: DropdownButton<ThemeMode>(
                    value: _themeMode,
                    underline: const SizedBox.shrink(),
                    onChanged: _onThemeChange,
                    items: const [
                      DropdownMenuItem(
                        value: ThemeMode.system,
                        child: Text("System"),
                      ),
                      DropdownMenuItem(
                        value: ThemeMode.light,
                        child: Text("Light"),
                      ),
                      DropdownMenuItem(
                        value: ThemeMode.dark,
                        child: Text("Dark"),
                      ),
                    ],
                  ),
                ),
                const Divider(),
                ListTile(
                  leading: const Icon(Icons.swap_vert),
                  title: const Text("Transfers"),
                  subtitle: const Text(
                    "See what's downloading, uploading, and processing.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const TransfersScreen(),
                    ),
                  ),
                ),
                const Divider(height: 1),
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
                SwitchListTile(
                  secondary: const Icon(Icons.battery_charging_full),
                  title: const Text("Sync while charging only"),
                  subtitle: const Text(
                    "Pause background uploads and Drive imports unless the "
                    "device is plugged in.",
                  ),
                  value: _chargingOnly,
                  onChanged: _onChargingOnlyToggle,
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
                // Phase B6 (storage placement) — workspace policy picker +
                // mirror coverage, mirroring the web Settings → Storage card.
                if (_storage != null) ...[
                  const Padding(
                    padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Text(
                      "STORAGE",
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                      ),
                    ),
                  ),
                  ListTile(
                    leading: const Icon(Icons.cloud_outlined),
                    title: const Text("Where originals live"),
                    subtitle: const Text(
                      "Mirror keeps a copy of every original on your NAS disk "
                      "as well as in the cloud.",
                    ),
                    trailing: _policyBusy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : DropdownButton<String>(
                            value: _storage!.isMirror ? "mirror" : "r2_only",
                            underline: const SizedBox.shrink(),
                            onChanged: _onPolicyChange,
                            items: const [
                              DropdownMenuItem(
                                value: "r2_only",
                                child: Text("Cloud only"),
                              ),
                              DropdownMenuItem(
                                value: "mirror",
                                child: Text("Mirror to NAS"),
                              ),
                            ],
                          ),
                  ),
                  if (_storage!.isMirror)
                    ListTile(
                      title: const Text("Mirror coverage"),
                      subtitle: Text(
                        "${_storage!.mirrored} / ${_storage!.eligible} originals copied "
                        "· ${_fmtBytes(_storage!.localBytes)} on the host",
                      ),
                    ),
                  const Divider(),
                ],
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
                  leading: const Icon(Icons.cloud_download_outlined),
                  title: const Text("Google Takeout"),
                  subtitle: const Text(
                    "Server-side import of a Google Takeout archive from your "
                    "Drive, with progress.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openImports("google"),
                ),
                ListTile(
                  leading: const Icon(Icons.photo_album_outlined),
                  title: const Text("Amazon Photos"),
                  subtitle: const Text(
                    "Upload an Amazon Photos .zip and import it server-side, "
                    "with progress.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openImports("amazon"),
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
                  leading: const Icon(Icons.photo_library_outlined),
                  title: const Text("Google Photos"),
                  subtitle: const Text(
                    "Pick photos in Google's picker and import them into Fonto.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) =>
                          const GooglePhotosImportScreen(virtualPath: "/"),
                    ),
                  ),
                ),
                const Divider(height: 1),
                // M14 / ADR 0057 — full library export (manifest + originals).
                ListTile(
                  leading: const Icon(Icons.download_for_offline_outlined),
                  title: const Text("Export everything"),
                  subtitle: const Text(
                    "Download your whole library — every original photo & "
                    "video, plus a manifest.",
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _exportLibrary,
                ),
                // M14 / ADR 0055 — instance-admin console, admin-only.
                if (_isAdmin) ...[
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.admin_panel_settings_outlined),
                    title: const Text("Instance admin"),
                    subtitle: const Text(
                      "Server stats, users, and per-workspace storage quotas.",
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _openAdmin,
                  ),
                ],
                if (widget.auth != null) ...[
                  const Divider(),
                  const Padding(
                    padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Text(
                      "ACCOUNT",
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                      ),
                    ),
                  ),
                  _buildAccountIdentity(),
                  ListTile(
                    leading: const Icon(Icons.open_in_new),
                    title: const Text("Manage account"),
                    subtitle: Text(
                      "Change name, email, or password on ${_accountHost()}.",
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _openWebAccount,
                  ),
                  ListTile(
                    leading: Icon(
                      Icons.logout,
                      color: Theme.of(context).colorScheme.error,
                    ),
                    title: Text(
                      "Sign out",
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                    onTap: widget.onSignOut == null ? null : _signOut,
                  ),
                ],
              ],
            ),
    );
  }
}
