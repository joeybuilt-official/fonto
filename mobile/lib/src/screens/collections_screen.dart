// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Collections tab. Four lazy sub-tabs — Albums / Smart / Projects /
// Stacks — each its own StatefulWidget loading on first build. Mirrors
// home_screen.dart's loading / error+retry / data state machine.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";

class CollectionsScreen extends StatelessWidget {
  const CollectionsScreen({super.key, required this.client});

  final FontoClient client;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
      child: Scaffold(
        appBar: AppBar(
          title: const Text("Collections"),
          bottom: const TabBar(
            tabs: [
              Tab(text: "Albums"),
              Tab(text: "Smart"),
              Tab(text: "Projects"),
              Tab(text: "Stacks"),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _AlbumsTab(client: client),
            _SmartTab(client: client),
            _ProjectsTab(client: client),
            _StacksTab(client: client),
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
    return const Center(child: Text("Nothing here yet"));
  }
  return builder();
}

class _AlbumsTab extends StatefulWidget {
  const _AlbumsTab({required this.client});
  final FontoClient client;

  @override
  State<_AlbumsTab> createState() => _AlbumsTabState();
}

class _AlbumsTabState extends State<_AlbumsTab> {
  bool _loading = true;
  String? _error;
  List<Collection> _items = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = await widget.client.listCollections();
      if (!mounted) return;
      setState(() {
        _items = items;
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
      onRetry: _load,
      builder: () => ListView.builder(
        itemCount: _items.length,
        itemBuilder: (context, i) {
          final c = _items[i];
          return ListTile(
            leading: const Icon(Icons.photo_album_outlined),
            title: Text(c.name),
            subtitle: c.description == null
                ? null
                : Text(c.description!, overflow: TextOverflow.ellipsis),
          );
        },
      ),
    );
  }
}

class _SmartTab extends StatefulWidget {
  const _SmartTab({required this.client});
  final FontoClient client;

  @override
  State<_SmartTab> createState() => _SmartTabState();
}

class _SmartTabState extends State<_SmartTab> {
  bool _loading = true;
  String? _error;
  List<SmartCollection> _items = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = await widget.client.listSmartCollections();
      if (!mounted) return;
      setState(() {
        _items = items;
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
      onRetry: _load,
      builder: () => ListView.builder(
        itemCount: _items.length,
        itemBuilder: (context, i) {
          final c = _items[i];
          return ListTile(
            leading: const Icon(Icons.auto_awesome_outlined),
            title: Text(c.name),
            subtitle: c.query == null
                ? null
                : Text(c.query!, overflow: TextOverflow.ellipsis),
          );
        },
      ),
    );
  }
}

class _ProjectsTab extends StatefulWidget {
  const _ProjectsTab({required this.client});
  final FontoClient client;

  @override
  State<_ProjectsTab> createState() => _ProjectsTabState();
}

class _ProjectsTabState extends State<_ProjectsTab> {
  bool _loading = true;
  String? _error;
  List<Project> _items = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = await widget.client.listProjects();
      if (!mounted) return;
      setState(() {
        _items = items;
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
      onRetry: _load,
      builder: () => ListView.builder(
        itemCount: _items.length,
        itemBuilder: (context, i) {
          final p = _items[i];
          return ListTile(
            leading: const Icon(Icons.folder_special_outlined),
            title: Text(p.name),
            subtitle: p.description == null
                ? null
                : Text(p.description!, overflow: TextOverflow.ellipsis),
          );
        },
      ),
    );
  }
}

class _StacksTab extends StatefulWidget {
  const _StacksTab({required this.client});
  final FontoClient client;

  @override
  State<_StacksTab> createState() => _StacksTabState();
}

class _StacksTabState extends State<_StacksTab> {
  bool _loading = true;
  String? _error;
  List<AssetStack> _items = const [];
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
      final items = await widget.client.listStacks();
      final thumbs = items.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(
              items.map((s) => s.primaryAssetId).toList(),
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
    return _stateScaffold(
      loading: _loading,
      error: _error,
      isEmpty: _items.isEmpty,
      onRetry: _load,
      builder: () => GridView.builder(
        padding: const EdgeInsets.all(8),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
          childAspectRatio: 0.85,
        ),
        itemCount: _items.length,
        itemBuilder: (context, i) {
          final s = _items[i];
          return _StackTile(
            stack: s,
            url: _thumbs[s.primaryAssetId],
          );
        },
      ),
    );
  }
}

class _StackTile extends StatelessWidget {
  const _StackTile({required this.stack, required this.url});
  final AssetStack stack;
  final String? url;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: url == null
                ? Container(color: Colors.black12)
                : CachedNetworkImage(
                    imageUrl: url!,
                    fit: BoxFit.cover,
                    width: double.infinity,
                    placeholder: (_, __) => Container(color: Colors.black12),
                    errorWidget: (_, __, ___) =>
                        const Icon(Icons.broken_image),
                  ),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          stack.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyMedium,
        ),
        Text(
          "${stack.memberCount} items",
          style: theme.textTheme.labelSmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
      ],
    );
  }
}
