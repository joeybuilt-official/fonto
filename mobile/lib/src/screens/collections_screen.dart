// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Collections tab. Google Photos-style landing surface — utility tiles
// (Favorites / Trash / Screenshots / Archive / Documents), People & Pets
// card, reverse-geocoded Places mosaic — sitting above four lazy sub-tabs
// (Albums / Smart / Projects / Stacks) that each load on first build.
//
// Mirrors the web Collections screen (`app/(app)/app/collections/page.tsx`
// + co-located `_components/`). Web/mobile parity is enforced so the user
// has one mental model across surfaces.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";
import "asset_detail_screen.dart";
import "filtered_assets_screen.dart";

class CollectionsScreen extends StatelessWidget {
  const CollectionsScreen({super.key, required this.client});

  final FontoClient client;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
      child: Scaffold(
        appBar: AppBar(title: const Text("Collections")),
        body: NestedScrollView(
          headerSliverBuilder: (context, _) => [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                child: _UtilityTileGrid(client: client),
              ),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                child: _PeopleCard(client: client),
              ),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                child: _PlacesSection(client: client),
              ),
            ),
          ],
          body: Column(
            children: [
              const TabBar(
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                tabs: [
                  Tab(text: "Albums"),
                  Tab(text: "Smart"),
                  Tab(text: "Projects"),
                  Tab(text: "Stacks"),
                ],
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    _AlbumsTab(client: client),
                    _SmartTab(client: client),
                    _ProjectsTab(client: client),
                    _StacksTab(client: client),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shared loading / error+retry / empty / data scaffold so each sub-tab
/// renders the same shape as home_screen.dart. Phase 7 — uses the shared
/// `ListErrorState` + `ListEmptyState` widgets and accepts tab-specific
/// empty copy so each tab can say what's actually missing.
Widget _stateScaffold({
  required bool loading,
  required String? error,
  required bool isEmpty,
  required VoidCallback onRetry,
  required Widget Function() builder,
  String emptyText = "Nothing here yet.",
  IconData emptyIcon = Icons.collections_bookmark_outlined,
}) {
  if (loading) {
    return const Center(child: CircularProgressIndicator());
  }
  if (error != null) {
    return ListErrorState(onRetry: onRetry);
  }
  if (isEmpty) {
    return ListEmptyState(icon: emptyIcon, message: emptyText);
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
      emptyText: "No albums yet. Create one to organize your assets.",
      emptyIcon: Icons.folder_open_outlined,
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
      emptyText: "No smart collections yet. Saved searches show up here.",
      emptyIcon: Icons.auto_awesome_outlined,
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
      emptyText:
          "No projects yet. Create a project to organize albums and collections.",
      emptyIcon: Icons.folder_special_outlined,
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
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) =>
                    _ProjectDetailScreen(client: widget.client, project: p),
              ),
            ),
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
      emptyText:
          "No stacks yet. RAW+JPEG pairs and bursts will surface here.",
      emptyIcon: Icons.layers_outlined,
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

/// Project detail — lists the collections that belong to a project. Tapping a
/// collection opens its asset grid. Projects group collections, not assets
/// directly, so this is a project → collection → photos drill-in.
class _ProjectDetailScreen extends StatefulWidget {
  const _ProjectDetailScreen({required this.client, required this.project});
  final FontoClient client;
  final Project project;

  @override
  State<_ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends State<_ProjectDetailScreen> {
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
      final items = await widget.client.projectCollections(widget.project.id);
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
    return Scaffold(
      appBar: AppBar(title: Text(widget.project.name)),
      body: _stateScaffold(
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
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => _CollectionAssetsScreen(
                    client: widget.client,
                    collection: c,
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Asset grid for one collection. Mirrors the People → person-assets grid.
class _CollectionAssetsScreen extends StatefulWidget {
  const _CollectionAssetsScreen({
    required this.client,
    required this.collection,
  });
  final FontoClient client;
  final Collection collection;

  @override
  State<_CollectionAssetsScreen> createState() =>
      _CollectionAssetsScreenState();
}

class _CollectionAssetsScreenState extends State<_CollectionAssetsScreen> {
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
    });
    try {
      final assets =
          await widget.client.assetsByCollection(widget.collection.id);
      final thumbs = assets.isEmpty
          ? <String, String>{}
          : await widget.client
              .assetUrls(assets.map((a) => a.id).toList(), variant: "thumb");
      if (!mounted) return;
      setState(() {
        _assets = assets;
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
    return Scaffold(
      appBar: AppBar(title: Text(widget.collection.name)),
      body: _stateScaffold(
        loading: _loading,
        error: _error,
        isEmpty: _assets.isEmpty,
        onRetry: _load,
        builder: () => GridView.builder(
          padding: const EdgeInsets.all(4),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            crossAxisSpacing: 4,
            mainAxisSpacing: 4,
          ),
          itemCount: _assets.length,
          itemBuilder: (context, i) => GestureDetector(
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => AssetDetailScreen(
                  client: widget.client,
                  assets: _assets,
                  initialIndex: i,
                ),
              ),
            ),
            child: _thumbs[_assets[i].id] == null
                ? Container(color: Colors.black12)
                : CachedNetworkImage(
                    imageUrl: _thumbs[_assets[i].id]!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => Container(color: Colors.black12),
                    errorWidget: (_, __, ___) => const ColoredBox(
                      color: Colors.black12,
                      child: Icon(Icons.broken_image),
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Google Photos-style header sections — utility tiles, People & Pets, Places
// ---------------------------------------------------------------------------

String _fmtCount(int n) {
  if (n < 1000) return n.toString();
  final k = n / 1000;
  return k >= 10 ? "${k.floor()}k" : "${k.toStringAsFixed(1)}k";
}

class _UtilityTile {
  const _UtilityTile({
    required this.label,
    required this.icon,
    required this.color,
    required this.openFilter,
  });
  final String label;
  final IconData icon;
  final Color color;
  final FilteredAssetsScreen Function(FontoClient) openFilter;
}

class _UtilityTileGrid extends StatefulWidget {
  const _UtilityTileGrid({required this.client});
  final FontoClient client;

  @override
  State<_UtilityTileGrid> createState() => _UtilityTileGridState();
}

class _UtilityTileGridState extends State<_UtilityTileGrid> {
  CollectionsStats? _stats;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await widget.client.collectionsStats();
      if (!mounted) return;
      setState(() => _stats = s);
    } catch (_) {
      // Tile counts are non-critical — render labels without numbers.
    }
  }

  @override
  Widget build(BuildContext context) {
    final tiles = <(_UtilityTile, int?)>[
      (
        _UtilityTile(
          label: "Favorites",
          icon: Icons.star,
          color: Colors.amber,
          openFilter: (c) =>
              FilteredAssetsScreen(client: c, title: "Favorites", favorite: true),
        ),
        _stats?.favorites,
      ),
      (
        _UtilityTile(
          label: "Trash",
          icon: Icons.delete_outline,
          color: Colors.redAccent,
          openFilter: (c) => FilteredAssetsScreen(
            client: c,
            title: "Trash",
            lifecycle: "trashed",
          ),
        ),
        _stats?.trash,
      ),
      (
        _UtilityTile(
          label: "Screenshots",
          icon: Icons.smartphone,
          color: Colors.blueAccent,
          openFilter: (c) => FilteredAssetsScreen(
            client: c,
            title: "Screenshots",
            kind: "screenshot",
          ),
        ),
        _stats?.screenshots,
      ),
      (
        _UtilityTile(
          label: "Archive",
          icon: Icons.archive_outlined,
          color: Colors.grey,
          openFilter: (c) => FilteredAssetsScreen(
            client: c,
            title: "Archive",
            lifecycle: "archived",
          ),
        ),
        _stats?.archived,
      ),
      (
        _UtilityTile(
          label: "Documents",
          icon: Icons.description_outlined,
          color: Colors.green,
          openFilter: (c) => FilteredAssetsScreen(
            client: c,
            title: "Documents",
            kind: "document",
          ),
        ),
        _stats?.documents,
      ),
    ];

    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: tiles.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        mainAxisExtent: 56,
      ),
      itemBuilder: (context, i) {
        final (t, count) = tiles[i];
        return _TileCard(
          tile: t,
          count: count,
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => t.openFilter(widget.client)),
          ),
        );
      },
    );
  }
}

class _TileCard extends StatelessWidget {
  const _TileCard({
    required this.tile,
    required this.count,
    required this.onTap,
  });
  final _UtilityTile tile;
  final int? count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: [
              Icon(tile.icon, color: tile.color, size: 22),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  tile.label,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (count != null)
                Text(
                  _fmtCount(count!),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PeopleCard extends StatefulWidget {
  const _PeopleCard({required this.client});
  final FontoClient client;

  @override
  State<_PeopleCard> createState() => _PeopleCardState();
}

class _PeopleCardState extends State<_PeopleCard> {
  List<Person> _people = const [];
  int? _total;
  // coverFaceCropUrl points at /api/v1/faces/<id>/crop-url which returns
  // JSON {url: <signed>} — not a direct image. Resolve through the API
  // client + cache the signed URL per person so CachedNetworkImage gets a
  // real image URL. Mirrors the web people-card.tsx + people/page.tsx
  // FaceCrop flow.
  final Map<String, String> _resolvedFaceUrls = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final all = await widget.client.listPersons();
      if (!mounted) return;
      final preview = all.take(4).toList();
      setState(() {
        _people = preview;
        _total = all.length;
      });
      // Resolve face-crop URLs in parallel. Failures stay null and the
      // tile falls back to the person-icon placeholder.
      await Future.wait(preview.map((p) async {
        final ref = p.coverFaceCropUrl;
        if (ref == null) return;
        final signed = await widget.client.resolveSignedUrl(ref);
        if (signed == null || !mounted) return;
        setState(() => _resolvedFaceUrls[p.id] = signed);
      }));
    } catch (_) {
      // Section is best-effort; stays hidden on failure.
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_people.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);

    return Material(
      color: theme.colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: theme.colorScheme.outlineVariant),
      ),
      // People isn't a Collections sub-tab — the Explore screen owns People,
      // and there's no deep-link target yet. Render the card as a static
      // teaser (no tap affordance / chevron) so we don't imply navigation
      // that doesn't happen.
      child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              SizedBox(
                width: 96,
                height: 96,
                child: GridView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: 4,
                  gridDelegate:
                      const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    mainAxisSpacing: 4,
                    crossAxisSpacing: 4,
                  ),
                  itemBuilder: (context, i) {
                    final p = i < _people.length ? _people[i] : null;
                    final url = p == null ? null : _resolvedFaceUrls[p.id];
                    return ClipOval(
                      child: url == null
                          ? Container(
                              color: theme.colorScheme.surfaceContainerHighest,
                              child: Icon(
                                Icons.person_outline,
                                size: 18,
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            )
                          : CachedNetworkImage(
                              imageUrl: url,
                              fit: BoxFit.cover,
                              placeholder: (_, __) => Container(
                                color:
                                    theme.colorScheme.surfaceContainerHighest,
                              ),
                              errorWidget: (_, __, ___) => Container(
                                color:
                                    theme.colorScheme.surfaceContainerHighest,
                              ),
                            ),
                    );
                  },
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      "People & Pets",
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (_total != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        "$_total ${_total == 1 ? "person" : "people"}",
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ); // Material > Padding > Row
  }
}

class _PlacesSection extends StatefulWidget {
  const _PlacesSection({required this.client});
  final FontoClient client;

  @override
  State<_PlacesSection> createState() => _PlacesSectionState();
}

class _PlacesSectionState extends State<_PlacesSection> {
  bool _loading = true;
  List<PlaceGroup> _places = const [];
  Map<String, String> _thumbs = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final places = await widget.client.places();
      if (places.isEmpty) {
        if (mounted) setState(() => _loading = false);
        return;
      }
      final allIds = places.expand((p) => p.previewIds).toList();
      Map<String, String> urls = const {};
      if (allIds.isNotEmpty) {
        try {
          urls = await widget.client.assetUrls(allIds);
        } catch (_) {
          urls = const {};
        }
      }
      if (!mounted) return;
      setState(() {
        _places = places;
        _thumbs = urls;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading || _places.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              Icon(
                Icons.location_on_outlined,
                size: 18,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Text(
                "Places",
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: 160,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 4),
            itemCount: _places.length,
            separatorBuilder: (_, __) => const SizedBox(width: 10),
            itemBuilder: (context, i) {
              final p = _places[i];
              return _PlaceCard(
                place: p,
                thumbs: _thumbs,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => FilteredAssetsScreen(
                      client: widget.client,
                      title: p.placeName,
                      place: p.placeName,
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _PlaceCard extends StatelessWidget {
  const _PlaceCard({
    required this.place,
    required this.thumbs,
    required this.onTap,
  });
  final PlaceGroup place;
  final Map<String, String> thumbs;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final city = place.placeName.split(",").first.trim();

    return SizedBox(
      width: 132,
      child: Material(
        color: theme.colorScheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AspectRatio(
                aspectRatio: 1,
                child: GridView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: 4,
                  gridDelegate:
                      const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                  ),
                  itemBuilder: (context, i) {
                    final id =
                        i < place.previewIds.length ? place.previewIds[i] : null;
                    final url = id == null ? null : thumbs[id];
                    if (url == null) {
                      return Container(
                        color: theme.colorScheme.surfaceContainerHighest,
                      );
                    }
                    return CachedNetworkImage(
                      imageUrl: url,
                      fit: BoxFit.cover,
                      memCacheWidth: 200,
                      memCacheHeight: 200,
                      placeholder: (_, __) => Container(
                        color: theme.colorScheme.surfaceContainerHighest,
                      ),
                      errorWidget: (_, __, ___) => Container(
                        color: theme.colorScheme.surfaceContainerHighest,
                      ),
                    );
                  },
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      city.isEmpty ? place.placeName : city,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      "${place.count} ${place.count == 1 ? "photo" : "photos"}",
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
