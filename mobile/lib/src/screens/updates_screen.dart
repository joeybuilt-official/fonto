// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Updates tab. Three lazy sub-tabs — Uploads / Activity / Shared —
// mirroring the web Updates surface (app/(app)/app/updates). Uploads is
// the newest-assets grid; Activity is the workspace feed with
// human-readable lines + cursor "load more"; Shared lists assets shared
// into this workspace with a source-workspace badge. Each sub-tab is its
// own StatefulWidget loading on first build, same state machine as
// collections_screen.dart / home_screen.dart.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "asset_detail_screen.dart";

class UpdatesScreen extends StatelessWidget {
  const UpdatesScreen({super.key, required this.client});

  final FontoClient client;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text("Updates"),
          bottom: const TabBar(
            tabs: [
              Tab(text: "Uploads"),
              Tab(text: "Activity"),
              Tab(text: "Shared"),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _UploadsTab(client: client),
            _ActivityTab(client: client),
            _SharedTab(client: client),
          ],
        ),
      ),
    );
  }
}

/// Shared loading / error+retry / empty / data scaffold so each sub-tab
/// renders the same shape as home_screen.dart.
Widget _stateScaffold({
  required bool loading,
  required String? error,
  required bool isEmpty,
  required String emptyText,
  required VoidCallback onRetry,
  required Widget Function() builder,
}) {
  if (loading) {
    return const Center(child: CircularProgressIndicator());
  }
  if (error != null) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40),
            const SizedBox(height: 12),
            Text(error, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text("Retry")),
          ],
        ),
      ),
    );
  }
  if (isEmpty) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(emptyText, textAlign: TextAlign.center),
      ),
    );
  }
  return builder();
}

// --------------------------------------------------------------------------
// Uploads — newest assets (reuse listAssets), grid → detail.
// --------------------------------------------------------------------------

class _UploadsTab extends StatefulWidget {
  const _UploadsTab({required this.client});
  final FontoClient client;

  @override
  State<_UploadsTab> createState() => _UploadsTabState();
}

class _UploadsTabState extends State<_UploadsTab> {
  bool _loading = true;
  String? _error;
  List<Asset> _assets = const [];
  final Map<String, String> _thumbs = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _thumbs.clear();
    });
    try {
      final page = await widget.client.listAssets(limit: 60);
      final thumbs = page.assets.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(
              page.assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _assets = page.assets;
        _thumbs.addAll(thumbs);
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _error = msg;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return _stateScaffold(
      loading: _loading,
      error: _error,
      isEmpty: _assets.isEmpty,
      emptyText: "No uploads yet.",
      onRetry: _load,
      builder: () => GridView.builder(
        padding: const EdgeInsets.all(4),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 4,
          mainAxisSpacing: 4,
        ),
        itemCount: _assets.length,
        itemBuilder: (context, i) => _GridThumb(
          url: _thumbs[_assets[i].id],
          heroTag: _assets[i].id,
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => AssetDetailScreen(
                client: widget.client,
                assets: _assets,
                initialIndex: i,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// --------------------------------------------------------------------------
// Activity — workspace feed, human-readable lines + cursor "load more".
// --------------------------------------------------------------------------

class _ActivityTab extends StatefulWidget {
  const _ActivityTab({required this.client});
  final FontoClient client;

  @override
  State<_ActivityTab> createState() => _ActivityTabState();
}

class _ActivityTabState extends State<_ActivityTab> {
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  final List<ActivityEvent> _events = [];
  String? _cursor;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _events.clear();
      _cursor = null;
    });
    try {
      final page = await widget.client.listActivity(limit: 50);
      if (!mounted) return;
      setState(() {
        _events.addAll(page.events);
        _cursor = page.nextCursor;
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  Future<void> _loadMore() async {
    if (_cursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final page = await widget.client.listActivity(
        limit: 50,
        createdBefore: _cursor,
      );
      if (!mounted) return;
      setState(() {
        _events.addAll(page.events);
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
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
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return _stateScaffold(
      loading: _loading,
      error: _error,
      isEmpty: _events.isEmpty,
      emptyText: "No activity yet. Comments, uploads, and shares show up here.",
      onRetry: _load,
      builder: () => ListView.builder(
        padding: const EdgeInsets.all(8),
        itemCount: _events.length + (_cursor != null ? 1 : 0),
        itemBuilder: (context, i) {
          if (i >= _events.length) {
            return Padding(
              padding: const EdgeInsets.all(12),
              child: Center(
                child: _loadingMore
                    ? const CircularProgressIndicator()
                    : OutlinedButton(
                        onPressed: _loadMore,
                        child: const Text("Load more"),
                      ),
              ),
            );
          }
          return _ActivityTile(event: _events[i]);
        },
      ),
    );
  }
}

class _ActivityTile extends StatelessWidget {
  const _ActivityTile({required this.event});
  final ActivityEvent event;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: Icon(_iconFor(event.kind)),
        title: Text(_summarize(event)),
        trailing: Text(
          _relativeTime(event.createdAt),
          style: theme.textTheme.labelSmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
      ),
    );
  }
}

IconData _iconFor(String kind) {
  switch (kind) {
    case "comment.posted":
    case "comment.deleted":
      return Icons.mode_comment_outlined;
    case "asset.uploaded":
      return Icons.upload_outlined;
    default:
      return Icons.bolt_outlined;
  }
}

/// Mirrors the web activity-section summarize(): actor is the first 8
/// chars of the user id (or "someone"); message varies by kind.
String _summarize(ActivityEvent e) {
  final id = e.actorUserId;
  final actor = (id != null && id.isNotEmpty)
      ? (id.length <= 8 ? id : id.substring(0, 8))
      : "someone";
  switch (e.kind) {
    case "comment.posted":
      final excerpt = e.payload["excerpt"];
      return excerpt is String && excerpt.isNotEmpty
          ? "$actor commented: $excerpt"
          : "$actor posted a comment";
    case "comment.deleted":
      return "$actor deleted a comment";
    case "asset.uploaded":
      return "$actor uploaded a new asset";
    default:
      return "$actor · ${e.kind}";
  }
}

String _relativeTime(DateTime t) {
  final mins = DateTime.now().difference(t).inMinutes;
  if (mins < 1) return "just now";
  if (mins < 60) return "${mins}m";
  final hrs = mins ~/ 60;
  if (hrs < 24) return "${hrs}h";
  final days = hrs ~/ 24;
  if (days < 7) return "${days}d";
  return "${t.year}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}";
}

// --------------------------------------------------------------------------
// Shared — assets shared into this workspace, grid + source badge.
// --------------------------------------------------------------------------

class _SharedTab extends StatefulWidget {
  const _SharedTab({required this.client});
  final FontoClient client;

  @override
  State<_SharedTab> createState() => _SharedTabState();
}

class _SharedTabState extends State<_SharedTab> {
  bool _loading = true;
  String? _error;
  List<SharedAsset> _items = const [];
  final Map<String, String> _thumbs = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _thumbs.clear();
    });
    try {
      final items = await widget.client.sharedWithMe();
      final thumbs = items.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(
              items.map((s) => s.asset.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _items = items;
        _thumbs.addAll(thumbs);
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _error = msg;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final assets = _items.map((s) => s.asset).toList();
    return _stateScaffold(
      loading: _loading,
      error: _error,
      isEmpty: _items.isEmpty,
      emptyText: "Nothing shared with you yet.",
      onRetry: _load,
      builder: () => GridView.builder(
        padding: const EdgeInsets.all(4),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 4,
          mainAxisSpacing: 4,
        ),
        itemCount: _items.length,
        itemBuilder: (context, i) => _GridThumb(
          url: _thumbs[_items[i].asset.id],
          heroTag: _items[i].asset.id,
          badge: _items[i].sourceWorkspaceName,
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => AssetDetailScreen(
                client: widget.client,
                assets: assets,
                initialIndex: i,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// --------------------------------------------------------------------------
// Shared grid thumbnail tile (used by Uploads + Shared).
// --------------------------------------------------------------------------

class _GridThumb extends StatelessWidget {
  const _GridThumb({
    required this.url,
    required this.heroTag,
    required this.onTap,
    this.badge,
  });

  final String? url;
  final String heroTag;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    final image = url == null
        ? Container(color: Colors.black12)
        : Hero(
            tag: heroTag,
            child: CachedNetworkImage(
              imageUrl: url!,
              fit: BoxFit.cover,
              placeholder: (_, __) => Container(color: Colors.black12),
              errorWidget: (_, __, ___) => const Icon(Icons.broken_image),
            ),
          );
    return GestureDetector(
      onTap: onTap,
      child: Stack(
        fit: StackFit.expand,
        children: [
          image,
          if (badge != null && badge!.isNotEmpty)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                color: Colors.black54,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.share, size: 11, color: Colors.white),
                    const SizedBox(width: 3),
                    Expanded(
                      child: Text(
                        badge!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
