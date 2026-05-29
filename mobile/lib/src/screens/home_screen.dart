// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Post-login landing. Stats bar + paginated asset grid w/
// pull-to-refresh + infinite scroll. Drawer = folder rail.
// AppBar search icon → SearchScreen. FAB → camera capture → upload.

import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";
import "package:flutter_doc_scanner/flutter_doc_scanner.dart";
import "package:image_picker/image_picker.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../state/auth_store.dart";
import "../state/upload_queue.dart";
import "asset_detail_screen.dart";
import "google_photos_import_screen.dart";
import "settings_screen.dart";
import "../state/camera_roll_scanner.dart";
import "../state/push_notifications.dart";
import "../state/settings_store.dart";

const _kPageSize = 60;

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, required this.onSignOut});

  final AuthStore auth;
  final VoidCallback onSignOut;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final FontoClient _client = FontoClient(widget.auth);
  final _picker = ImagePicker();
  final _scroll = ScrollController();

  bool _loadingFirst = true;
  bool _loadingMore = false;
  String? _error;
  WorkspaceStats? _stats;
  FolderTree? _tree;
  final List<Asset> _assets = [];
  final Map<String, String> _thumbs = {};
  AssetCursor? _cursor;
  bool _uploading = false;

  /// `null` → workspace root view (all assets, no filter).
  /// Otherwise filters via directoryPathPrefix.
  String? _folder;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
    _refresh();
    _refreshQueueBadge();
    _maybeScanCameraRoll();
  }

  @override
  void dispose() {
    _scroll.dispose();
    _client.close();
    super.dispose();
  }

  void _maybeLoadMore() {
    if (!_scroll.hasClients) return;
    if (_scroll.position.pixels <
        _scroll.position.maxScrollExtent - 600) {
      return;
    }
    if (_loadingMore || _cursor == null) return;
    _loadMore();
  }

  Future<void> _refresh() async {
    setState(() {
      _loadingFirst = true;
      _error = null;
      _assets.clear();
      _thumbs.clear();
      _cursor = null;
    });
    try {
      // Tree + stats fetched once per refresh; not per-page.
      final tree = await _client.folderTree();
      final stats = await _client.stats();
      final page = await _client.listAssets(
        limit: _kPageSize,
        directoryPathPrefix: _folder,
      );
      final thumbs = page.assets.isEmpty
          ? <String, String>{}
          : await _client.assetUrls(
              page.assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _stats = stats;
        _tree = tree;
        _assets.addAll(page.assets);
        _thumbs.addAll(thumbs);
        _cursor = page.nextCursor;
        _loadingFirst = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  Future<void> _loadMore() async {
    if (_cursor == null) return;
    setState(() => _loadingMore = true);
    try {
      final page = await _client.listAssets(
        limit: _kPageSize,
        after: _cursor,
        directoryPathPrefix: _folder,
      );
      final newThumbs = page.assets.isEmpty
          ? <String, String>{}
          : await _client.assetUrls(
              page.assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _assets.addAll(page.assets);
        _thumbs.addAll(newThumbs);
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Load failed: ${e.status} ${e.message}")),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Load failed: $e")),
      );
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _error = msg;
      _loadingFirst = false;
    });
  }

  Future<void> _showAddSheet() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt),
              title: const Text("Take photo"),
              onTap: () => Navigator.pop(context, "photo"),
            ),
            ListTile(
              leading: const Icon(Icons.document_scanner),
              title: const Text("Scan document"),
              onTap: () => Navigator.pop(context, "scan"),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text("Import from Google Photos"),
              onTap: () => Navigator.pop(context, "google_photos"),
            ),
            ListTile(
              leading: const Icon(Icons.folder_outlined),
              title: const Text("Import from Google Drive"),
              subtitle: const Text("Coming soon"),
              enabled: false,
              onTap: () => Navigator.pop(context, "google_drive"),
            ),
            ListTile(
              leading: const Icon(Icons.cloud_outlined),
              title: const Text("Import from Nextcloud"),
              subtitle: const Text("Coming soon"),
              enabled: false,
              onTap: () => Navigator.pop(context, "nextcloud"),
            ),
            ListTile(
              leading: const Icon(Icons.cloud_done_outlined),
              title: const Text("Import from iCloud"),
              subtitle: const Text("iOS only · coming soon"),
              enabled: false,
              onTap: () => Navigator.pop(context, "icloud"),
            ),
          ],
        ),
      ),
    );
    if (choice == "photo") await _captureAndUpload();
    if (choice == "scan") await _scanDocument();
    if (choice == "google_photos") await _importFromGooglePhotos();
  }

  Future<void> _importFromGooglePhotos() async {
    final imported = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => GooglePhotosImportScreen(
          virtualPath: _folder ?? "/",
        ),
      ),
    );
    if (!mounted) return;
    if (imported == true) {
      await _refreshQueueBadge();
      await _refresh();
    }
  }

  Future<void> _captureAndUpload() async {
    final picked = await _picker.pickImage(source: ImageSource.camera);
    if (picked == null) return;
    await _enqueueAndDrain(File(picked.path));
  }

  Future<void> _scanDocument() async {
    PdfScanResult? scan;
    try {
      scan = await FlutterDocScanner().getScannedDocumentAsPdf(page: 24);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Scan failed: $e")),
      );
      return;
    }
    if (scan == null) return; // user cancelled
    final path = _pdfPathFromUri(scan.pdfUri);
    if (path == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Scan produced an unreadable file.")),
      );
      return;
    }
    await _enqueueAndDrain(File(path));
  }

  // ML Kit returns a file:// URI into the app cache. Resolve to a real path
  // the queue can hash + read. content:// would need a platform-side copy we
  // don't have, so it's reported as unreadable rather than silently failing.
  String? _pdfPathFromUri(String pdfUri) {
    final uri = Uri.tryParse(pdfUri);
    if (uri == null || uri.scheme.isEmpty) return pdfUri;
    if (uri.scheme == "file") return uri.toFilePath();
    return null;
  }

  Future<void> _enqueueAndDrain(File file) async {
    setState(() => _uploading = true);
    try {
      final hash = await UploadQueue.hashFile(file);
      final queue = await UploadQueue.open();
      final inserted = await queue.enqueue(
        filePath: file.path,
        virtualPath: _folder ?? "/",
        sha256Hex: hash,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            inserted == null ? "Already queued." : "Queued for upload.",
          ),
        ),
      );
      await _refreshQueueBadge();
      // Foreground drain — quick win when the device is awake + online.
      // Workmanager keeps draining in the background even if we close.
      final ok = await UploadQueue.drain();
      if (!mounted) return;
      await _refreshQueueBadge();
      if (ok > 0) await _refresh();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Enqueue failed: $e")),
      );
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  int _queuedCount = 0;

  Future<void> _refreshQueueBadge() async {
    final q = await UploadQueue.open();
    final c = await q.pendingCount();
    if (!mounted) return;
    setState(() => _queuedCount = c);
  }

  Future<void> _maybeScanCameraRoll() async {
    final enabled = await SettingsStore.getAutoImport();
    if (!enabled) return;
    final n = await CameraRollScanner.scanAndEnqueue();
    if (n > 0) {
      await _refreshQueueBadge();
      // Best-effort foreground drain; don't await so we don't block the grid.
      UploadQueue.drain().then((_) {
        if (mounted) _refreshQueueBadge();
      });
    }
  }

  Future<void> _signOut() async {
    // Deregister the push token first — the DELETE needs the PAT still set.
    await PushNotifications.deregister(widget.auth);
    await widget.auth.clear();
    if (!mounted) return;
    widget.onSignOut();
  }

  Future<void> _openDetail(int i) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>?>(
      MaterialPageRoute(
        builder: (_) => AssetDetailScreen(
          client: _client,
          assets: _assets,
          initialIndex: i,
        ),
      ),
    );
    if (!mounted || result == null) return;
    // Detail popped w/ a trashed id — drop it from our local list so the
    // grid reflects the action without a full refresh.
    final trashedId = result["trashedId"] as String?;
    if (trashedId != null) {
      setState(() => _assets.removeWhere((a) => a.id == trashedId));
    }
  }

  void _selectFolder(String? folder) {
    Navigator.of(context).pop(); // close drawer
    if (folder == _folder) return;
    setState(() => _folder = folder);
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final title = _folder == null ? "Fonto" : _folder!;
    return Scaffold(
      appBar: AppBar(
        title: Text(title, overflow: TextOverflow.ellipsis),
        actions: [
          if (_queuedCount > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Center(
                child: Chip(
                  label: Text("$_queuedCount ↑"),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                ),
              ),
            ),
          PopupMenuButton<String>(
            icon: const Icon(Icons.account_circle_outlined),
            tooltip: "Account",
            onSelected: (v) {
              if (v == "signout") _signOut();
              if (v == "settings") {
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const SettingsScreen()),
                );
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(
                value: "settings",
                child: ListTile(
                  leading: Icon(Icons.settings_outlined),
                  title: Text("Settings"),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
              PopupMenuItem(
                value: "signout",
                child: ListTile(
                  leading: Icon(Icons.logout),
                  title: Text("Sign out"),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ],
          ),
        ],
      ),
      drawer: _FolderDrawer(
        tree: _tree,
        selected: _folder,
        onSelect: _selectFolder,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _uploading ? null : _showAddSheet,
        child: _uploading
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.add),
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loadingFirst) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 40),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: _refresh, child: const Text("Retry")),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: CustomScrollView(
        controller: _scroll,
        slivers: [
          if (_stats != null && _folder == null)
            SliverToBoxAdapter(child: _StatsBar(stats: _stats!)),
          if (_assets.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Text("No assets yet. Tap + to add."),
              ),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.all(4),
              sliver: SliverGrid(
                gridDelegate:
                    const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  crossAxisSpacing: 4,
                  mainAxisSpacing: 4,
                ),
                delegate: SliverChildBuilderDelegate(
                  (context, i) => _AssetTile(
                    asset: _assets[i],
                    url: _thumbs[_assets[i].id],
                    onTap: () => _openDetail(i),
                  ),
                  childCount: _assets.length,
                ),
              ),
            ),
          if (_loadingMore)
            const SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              ),
            ),
        ],
      ),
    );
  }
}

class _StatsBar extends StatelessWidget {
  const _StatsBar({required this.stats});
  final WorkspaceStats stats;

  @override
  Widget build(BuildContext context) {
    final pairs = <(String, int)>[
      ("Total", stats.total),
      ("Images", stats.images),
      ("Videos", stats.videos),
      ("Docs", stats.documents),
      ("★", stats.favorites),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: pairs
            .map((p) => Column(
                  children: [
                    Text(
                      "${p.$2}",
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      p.$1,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ],
                ))
            .toList(),
      ),
    );
  }
}

class _AssetTile extends StatelessWidget {
  const _AssetTile({
    required this.asset,
    required this.url,
    required this.onTap,
  });
  final Asset asset;
  final String? url;
  final VoidCallback onTap;

  bool get _isImage => asset.mimeType.startsWith("image/");
  bool get _isVideo => asset.mimeType.startsWith("video/");

  @override
  Widget build(BuildContext context) {
    final Widget media;
    if (url == null) {
      // No URL yet: images/videos get a neutral box; docs get the doc card.
      media = (_isImage || _isVideo)
          ? Container(color: Colors.black12)
          : _DocPlaceholder(asset: asset);
    } else if (_isImage || _isVideo) {
      media = Hero(
        tag: asset.id,
        child: CachedNetworkImage(
          imageUrl: url!,
          fit: BoxFit.cover,
          placeholder: (_, __) => Container(color: Colors.black12),
          errorWidget: (_, __, ___) => const ColoredBox(
            color: Colors.black12,
            child: Icon(Icons.broken_image),
          ),
        ),
      );
    } else {
      // Documents: show the server-rendered first-page thumb when present,
      // otherwise a clean doc card — never a broken-image icon. (The urls
      // endpoint falls back to the original PDF when no thumb exists, which
      // can't decode as an image, so the errorWidget is the common path
      // until the thumbnail worker catches up.)
      media = Hero(
        tag: asset.id,
        child: CachedNetworkImage(
          imageUrl: url!,
          fit: BoxFit.cover,
          placeholder: (_, __) => _DocPlaceholder(asset: asset),
          errorWidget: (_, __, ___) => _DocPlaceholder(asset: asset),
        ),
      );
    }

    return GestureDetector(
      onTap: onTap,
      child: Stack(
        fit: StackFit.expand,
        children: [
          media,
          if (!_isImage)
            Positioned(
              left: 4,
              top: 4,
              child: _TypeBadge(
                icon: _isVideo
                    ? Icons.play_circle_fill
                    : Icons.description,
              ),
            ),
        ],
      ),
    );
  }
}

/// Fallback card for document assets (or any non-image without a thumbnail).
/// Shows a doc icon, the file extension, and the filename so the user can
/// tell documents apart at a glance.
class _DocPlaceholder extends StatelessWidget {
  const _DocPlaceholder({required this.asset});
  final Asset asset;

  @override
  Widget build(BuildContext context) {
    final dot = asset.filename.lastIndexOf(".");
    final ext = dot > 0 && dot < asset.filename.length - 1
        ? asset.filename.substring(dot + 1).toUpperCase()
        : "DOC";
    return Container(
      color: const Color(0xFFECEAF4),
      padding: const EdgeInsets.all(6),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.description_outlined,
              size: 34, color: Colors.black54),
          const SizedBox(height: 4),
          Text(
            ext,
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 11,
              color: Colors.black54,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            asset.filename,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 10, color: Colors.black54),
          ),
        ],
      ),
    );
  }
}

/// Small corner chip marking videos (play) and documents (page).
class _TypeBadge extends StatelessWidget {
  const _TypeBadge({required this.icon});
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: Colors.black54,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Icon(icon, size: 16, color: Colors.white),
    );
  }
}

/// Drawer rail — folders rolled up from the flat /folders/tree response.
/// Top entry "All" clears the filter; "(root)" shows assets with NULL
/// directoryPath. Each path entry filters by that subtree prefix.
class _FolderDrawer extends StatelessWidget {
  const _FolderDrawer({
    required this.tree,
    required this.selected,
    required this.onSelect,
  });

  final FolderTree? tree;
  final String? selected;
  final ValueChanged<String?> onSelect;

  @override
  Widget build(BuildContext context) {
    final t = tree;
    return Drawer(
      child: SafeArea(
        child: t == null
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                children: [
                  ListTile(
                    leading: const Icon(Icons.all_inbox),
                    title: const Text("All"),
                    selected: selected == null,
                    onTap: () => onSelect(null),
                  ),
                  if (t.rootAssetCount > 0)
                    ListTile(
                      leading: const Icon(Icons.folder_outlined),
                      title: const Text("(root)"),
                      trailing: Text("${t.rootAssetCount}"),
                      selected: selected == "/",
                      onTap: () => onSelect("/"),
                    ),
                  const Divider(),
                  ...t.paths.map(
                    (p) => ListTile(
                      leading: const Icon(Icons.folder),
                      title: Text(
                        p.path,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: Text("${p.assetCount}"),
                      selected: selected == p.path,
                      onTap: () => onSelect(p.path),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
