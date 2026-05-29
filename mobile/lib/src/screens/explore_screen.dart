// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Explore tab. Three lazy sub-tabs — People / Places / Things —
// mirroring the web Explore hub (app/(app)/app/explore). People = face
// clusters (cover thumb, uncropped per ADR 0007 C2); Places = geo-tagged
// asset grid (listAssets hasGeo per C1) → detail; Things = "coming soon"
// placeholder matching the web tile. Same loading / error+retry / empty /
// data state machine as collections_screen.dart / updates_screen.dart.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "asset_detail_screen.dart";

class ExploreScreen extends StatelessWidget {
  const ExploreScreen({super.key, required this.client});

  final FontoClient client;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text("Explore"),
          bottom: const TabBar(
            tabs: [
              Tab(text: "People"),
              Tab(text: "Places"),
              Tab(text: "Things"),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _PeopleTab(client: client),
            _PlacesTab(client: client),
            const _ThingsTab(),
          ],
        ),
      ),
    );
  }
}

/// Shared loading / error+retry / empty / data scaffold.
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
// People — face clusters; cover thumb + name/count overlay.
// --------------------------------------------------------------------------

class _PeopleTab extends StatefulWidget {
  const _PeopleTab({required this.client});
  final FontoClient client;

  @override
  State<_PeopleTab> createState() => _PeopleTabState();
}

class _PeopleTabState extends State<_PeopleTab> {
  bool _loading = true;
  String? _error;
  List<Person> _items = const [];
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
      final items = await widget.client.listPersons();
      final coverIds = items
          .map((p) => p.coverAssetId)
          .whereType<String>()
          .toList();
      final thumbs = coverIds.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(coverIds, variant: "thumb");
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
    return _stateScaffold(
      loading: _loading,
      error: _error,
      isEmpty: _items.isEmpty,
      emptyText: "No people yet. Faces get grouped as your library grows.",
      onRetry: _load,
      builder: () => GridView.builder(
        padding: const EdgeInsets.all(8),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
          childAspectRatio: 0.8,
        ),
        itemCount: _items.length,
        itemBuilder: (context, i) => _PersonTile(
          person: _items[i],
          url: _thumbs[_items[i].coverAssetId],
        ),
      ),
    );
  }
}

class _PersonTile extends StatelessWidget {
  const _PersonTile({required this.person, required this.url});
  final Person person;
  final String? url;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ClipOval(
            child: url == null
                ? Container(
                    color: Colors.black12,
                    child: const Icon(Icons.person, size: 36),
                  )
                : CachedNetworkImage(
                    imageUrl: url!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => Container(color: Colors.black12),
                    errorWidget: (_, __, ___) => const Icon(Icons.person),
                  ),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          person.name ?? "Unnamed",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodySmall,
        ),
        Text(
          "${person.instanceCount}",
          textAlign: TextAlign.center,
          style: theme.textTheme.labelSmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
      ],
    );
  }
}

// --------------------------------------------------------------------------
// Places — geo-tagged asset grid (listAssets hasGeo) → detail.
// --------------------------------------------------------------------------

class _PlacesTab extends StatefulWidget {
  const _PlacesTab({required this.client});
  final FontoClient client;

  @override
  State<_PlacesTab> createState() => _PlacesTabState();
}

class _PlacesTabState extends State<_PlacesTab> {
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
      final page = await widget.client.listAssets(limit: 60, hasGeo: true);
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
      emptyText: "No geo-tagged photos yet.",
      onRetry: _load,
      builder: () => GridView.builder(
        padding: const EdgeInsets.all(4),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 4,
          mainAxisSpacing: 4,
        ),
        itemCount: _assets.length,
        itemBuilder: (context, i) => _PlaceThumb(
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

class _PlaceThumb extends StatelessWidget {
  const _PlaceThumb({
    required this.url,
    required this.heroTag,
    required this.onTap,
  });
  final String? url;
  final String heroTag;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final inner = url == null
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
    return GestureDetector(onTap: onTap, child: inner);
  }
}

// --------------------------------------------------------------------------
// Things — placeholder matching the web "coming soon" tile.
// --------------------------------------------------------------------------

class _ThingsTab extends StatelessWidget {
  const _ThingsTab();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.auto_awesome_outlined,
                size: 48, color: theme.colorScheme.primary),
            const SizedBox(height: 16),
            Text("Things — coming soon", style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              "Browse by what's in your photos, auto-classified.",
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ],
        ),
      ),
    );
  }
}
