// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Post-login landing. Stats bar + paginated asset grid w/
// pull-to-refresh + infinite scroll. Drawer = folder rail.
// AppBar search icon → SearchScreen. FAB → camera capture → upload.

import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";
import "package:image_picker/image_picker.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../state/auth_store.dart";
import "asset_detail_screen.dart";
import "search_screen.dart";

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

  Future<void> _captureAndUpload() async {
    final picked = await _picker.pickImage(source: ImageSource.camera);
    if (picked == null) return;
    setState(() => _uploading = true);
    try {
      await _client.uploadFile(
        File(picked.path),
        virtualPath: _folder ?? "/",
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Uploaded.")),
      );
      await _refresh();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Upload failed: ${e.status} ${e.message}")),
      );
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _signOut() async {
    await widget.auth.clear();
    if (!mounted) return;
    widget.onSignOut();
  }

  void _openSearch() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SearchScreen(client: _client),
      ),
    );
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
          IconButton(
            icon: const Icon(Icons.search),
            tooltip: "Search",
            onPressed: _openSearch,
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: "Sign out",
            onPressed: _signOut,
          ),
        ],
      ),
      drawer: _FolderDrawer(
        tree: _tree,
        selected: _folder,
        onSelect: _selectFolder,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _uploading ? null : _captureAndUpload,
        child: _uploading
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.camera_alt),
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
                child: Text("No assets yet. Tap the camera FAB."),
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

  @override
  Widget build(BuildContext context) {
    final inner = url == null
        ? Container(color: Colors.black12)
        : Hero(
            tag: asset.id,
            child: CachedNetworkImage(
              imageUrl: url!,
              fit: BoxFit.cover,
              placeholder: (_, __) => Container(color: Colors.black12),
              errorWidget: (_, __, ___) => const Icon(Icons.broken_image),
            ),
          );
    return GestureDetector(onTap: onTap, child: inner);
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
