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
            _ThingsTab(client: client),
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
  // Phase 3 (faces/UX) — resolved signed face-crop URLs, keyed by person id.
  // Prefer these sharp, centered crops over zooming a 256px thumb.
  final Map<String, String> _faceCrops = {};

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
      _faceCrops.clear();
    });
    try {
      final raw = await widget.client.listPersons();
      final seen = <String>{};
      final items = raw.where((p) => seen.add(p.id)).toList();
      final coverIds = items
          .map((p) => p.coverAssetId)
          .whereType<String>()
          .toList();
      final thumbs = coverIds.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(coverIds, variant: "thumb");
      // Phase 3 (faces/UX) — resolve the dedicated face-crop signed URL for any
      // person that has one. Done in parallel; failures just leave the thumb
      // fallback in place. NULL coverFaceCropUrl => not yet backfilled.
      final cropTargets =
          items.where((p) => p.coverFaceCropUrl != null).toList();
      final crops = <String, String>{};
      await Future.wait(cropTargets.map((p) async {
        final u = await widget.client.resolveSignedUrl(p.coverFaceCropUrl!);
        if (u != null) crops[p.id] = u;
      }));
      if (!mounted) return;
      setState(() {
        _items = items;
        _thumbs.addAll(thumbs);
        _faceCrops.addAll(crops);
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
          faceCropUrl: _faceCrops[_items[i].id],
          onTap: () async {
            final merged = await Navigator.of(context).push<bool>(
              MaterialPageRoute(
                builder: (_) => _PersonAssetsScreen(
                  client: widget.client,
                  person: _items[i],
                ),
              ),
            );
            if (merged == true) _load();
          },
        ),
      ),
    );
  }
}

class _PersonTile extends StatelessWidget {
  const _PersonTile({
    required this.person,
    required this.url,
    required this.onTap,
    this.faceCropUrl,
  });
  final Person person;
  final String? url;
  // Phase 3 (faces/UX) — resolved signed face-crop URL; preferred over zooming
  // the thumb when present (sharp + already centered).
  final String? faceCropUrl;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: LayoutBuilder(
              builder: (_, constraints) {
                final d = constraints.maxWidth;
                final bbox = person.coverBbox;
                final Widget inner;
                if (faceCropUrl != null) {
                  // Preferred: the dedicated sharp, centered crop. Render
                  // cover — the crop is already a tight square around the face.
                  inner = CachedNetworkImage(
                    imageUrl: faceCropUrl!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => Container(color: Colors.black12),
                    errorWidget: (_, __, ___) => const Icon(Icons.person),
                  );
                } else if (url == null) {
                  inner = Container(
                    color: Colors.black12,
                    child: const Icon(Icons.person, size: 36),
                  );
                } else if (bbox != null) {
                  // Fallback: zoom the thumb to the bbox (pre-backfill).
                  inner = _buildFaceZoom(url!, bbox, d);
                } else {
                  inner = CachedNetworkImage(
                    imageUrl: url!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => Container(color: Colors.black12),
                    errorWidget: (_, __, ___) => const Icon(Icons.person),
                  );
                }
                return ClipOval(child: SizedBox(width: d, height: d, child: inner));
              },
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
      ),
    );
  }
}

/// Zoom into the face described by [bbox] (normalised 0..1) within [url].
/// Translates + scales the image so the face center aligns with the widget
/// center and the face fills ~65% of the circle diameter.
Widget _buildFaceZoom(String url, PersonBbox bbox, double d) {
  final cx = bbox.cx;
  final cy = bbox.cy;
  final faceSize = bbox.w > bbox.h ? bbox.w : bbox.h;
  final scale = (0.65 / faceSize.clamp(0.05, 1.0)).clamp(1.5, 8.0);
  final tx = d / 2 - cx * d * scale;
  final ty = d / 2 - cy * d * scale;
  return Transform.translate(
    offset: Offset(tx, ty),
    child: Transform.scale(
      scale: scale,
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: d,
        height: d,
        child: CachedNetworkImage(
          imageUrl: url,
          fit: BoxFit.cover,
          placeholder: (_, __) => Container(color: Colors.black12),
          errorWidget: (_, __, ___) => const Icon(Icons.person),
        ),
      ),
    ),
  );
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
    required this.onTap,
  });
  final String? url;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final inner = url == null
        ? Container(color: Colors.black12)
        : CachedNetworkImage(
            imageUrl: url!,
            fit: BoxFit.cover,
            placeholder: (_, __) => Container(color: Colors.black12),
            errorWidget: (_, __, ___) => const Icon(Icons.broken_image),
          );
    return GestureDetector(onTap: onTap, child: inner);
  }
}

// --------------------------------------------------------------------------
// Things — auto-detected object/scene labels (+ user tags) as a tile grid.
// Tap a tile to drill into that label's assets.
// --------------------------------------------------------------------------

class _ThingsTab extends StatefulWidget {
  const _ThingsTab({required this.client});
  final FontoClient client;

  @override
  State<_ThingsTab> createState() => _ThingsTabState();
}

class _ThingsTabState extends State<_ThingsTab> {
  bool _loading = true;
  String? _error;
  List<TopTag> _items = const [];
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
      final items = await widget.client.topTags();
      final sampleIds =
          items.map((t) => t.sampleAssetId).whereType<String>().toList();
      final thumbs = sampleIds.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(sampleIds, variant: "thumb");
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
      emptyText:
          "No labels yet. Objects and scenes show up here as your photos are processed.",
      onRetry: _load,
      builder: () => GridView.builder(
        padding: const EdgeInsets.all(8),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
        ),
        itemCount: _items.length,
        itemBuilder: (context, i) => _ThingTile(
          tag: _items[i],
          url: _thumbs[_items[i].sampleAssetId],
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) =>
                  _TagAssetsScreen(client: widget.client, tag: _items[i]),
            ),
          ),
        ),
      ),
    );
  }
}

class _ThingTile extends StatelessWidget {
  const _ThingTile({required this.tag, required this.url, required this.onTap});
  final TopTag tag;
  final String? url;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (url != null)
              CachedNetworkImage(
                imageUrl: url!,
                fit: BoxFit.cover,
                placeholder: (_, __) => Container(color: Colors.black12),
                errorWidget: (_, __, ___) => Container(color: Colors.black12),
              )
            else
              Container(color: Colors.black12, child: const Icon(Icons.label_outline)),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.fromLTRB(8, 12, 8, 6),
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Colors.black87],
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      tag.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w600,
                        fontSize: 13,
                      ),
                    ),
                    Text(
                      "${tag.count}",
                      style: const TextStyle(color: Colors.white70, fontSize: 11),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Drill-in: assets carrying a single label/tag, in a 3-col grid → detail.
class _TagAssetsScreen extends StatefulWidget {
  const _TagAssetsScreen({required this.client, required this.tag});
  final FontoClient client;
  final TopTag tag;

  @override
  State<_TagAssetsScreen> createState() => _TagAssetsScreenState();
}

class _TagAssetsScreenState extends State<_TagAssetsScreen> {
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
      final assets = await widget.client.assetsByTag(widget.tag.id);
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
      appBar: AppBar(title: Text(widget.tag.name)),
      body: _stateScaffold(
        loading: _loading,
        error: _error,
        isEmpty: _assets.isEmpty,
        emptyText: "No assets for this label.",
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
                    errorWidget: (_, __, ___) =>
                        const ColoredBox(color: Colors.black12, child: Icon(Icons.broken_image)),
                  ),
          ),
        ),
      ),
    );
  }
}

/// Drill-in: all assets containing a recognised face for one person.
class _PersonAssetsScreen extends StatefulWidget {
  const _PersonAssetsScreen({required this.client, required this.person});
  final FontoClient client;
  final Person person;

  @override
  State<_PersonAssetsScreen> createState() => _PersonAssetsScreenState();
}

class _PersonAssetsScreenState extends State<_PersonAssetsScreen> {
  bool _loading = true;
  String? _error;
  List<Asset> _assets = const [];
  final Map<String, String> _thumbs = {};
  bool _merging = false;
  late String? _name;
  // Tracks whether anything the caller cares about has changed (rename,
  // remove name, merge). Used as the back-pop result so the People grid
  // refreshes the cluster list when the user navigates back.
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _name = widget.person.name;
    _load();
  }

  /// Merge this person into another. Loads the other people, lets the user
  /// pick a target, then POSTs the merge and pops back so the People grid
  /// reloads without the now-absorbed person.
  Future<void> _pickAndMerge() async {
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    List<Person> others;
    List<MergeCandidate> candidates;
    try {
      // Fan out both calls in parallel — the picker rendering only blocks on
      // the slower one and we surface candidates above the flat list.
      final results = await Future.wait([
        widget.client.listPersons(),
        widget.client.mergeCandidates(widget.person.id).catchError(
              (_) => <MergeCandidate>[],
            ),
      ]);
      others = (results[0] as List<Person>)
          .where((p) => p.id != widget.person.id)
          .toList();
      candidates = (results[1] as List<MergeCandidate>);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't load people: $e")));
      return;
    }
    if (!mounted) return;
    if (others.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text("No other people to merge into yet.")),
      );
      return;
    }
    // Drop unnamed clusters — merge target must be a named person. Use the
    // per-face tagging sheet to attach an unnamed face to someone.
    final candidateIds = candidates.map((c) => c.person.id).toSet();
    final namedCandidates =
        candidates.where((c) => (c.person.name ?? "").isNotEmpty).toList();
    final namedRest = others
        .where((p) => !candidateIds.contains(p.id))
        .where((p) => (p.name ?? "").isNotEmpty)
        .toList();
    if (namedCandidates.isEmpty && namedRest.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(
          content: Text("No named people to merge into yet."),
        ),
      );
      return;
    }
    final target = await showModalBottomSheet<Person>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _MergePicker(
        candidates: namedCandidates,
        others: namedRest,
      ),
    );
    if (target == null || !mounted) return;
    setState(() => _merging = true);
    try {
      await widget.client.mergePerson(widget.person.id, target.id);
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text("Merged into ${target.name ?? "person"}")),
      );
      navigator.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _merging = false);
      messenger.showSnackBar(SnackBar(content: Text("Merge failed: $e")));
    }
  }

  /// Phase 3 (faces/UX) — rename this person. Prompts for a new name and PATCHes
  /// it. Updates the local title; pops `true` so the People grid reloads.
  Future<void> _rename() async {
    final messenger = ScaffoldMessenger.of(context);
    final controller = TextEditingController(text: _name ?? "");
    final newName = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Rename person"),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: "Name"),
          onSubmitted: (v) => Navigator.of(ctx).pop(v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text("Cancel"),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text),
            child: const Text("Save"),
          ),
        ],
      ),
    );
    if (newName == null || !mounted) return;
    final trimmed = newName.trim();
    if (trimmed.isEmpty) return;
    try {
      final updated =
          await widget.client.updatePersonName(widget.person.id, trimmed);
      if (!mounted) return;
      setState(() {
        _name = updated.name;
        _changed = true;
      });
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text("Rename failed: $e")));
    }
  }

  /// Phase 3 (faces/UX) — remove (clear) this person's name. Sends `null`,
  /// which the PATCH route treats as "unname". Fixes the reported bug where the
  /// app could not clear a name at all.
  Future<void> _removeName() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final updated =
          await widget.client.updatePersonName(widget.person.id, null);
      if (!mounted) return;
      setState(() {
        _name = updated.name;
        _changed = true;
      });
      messenger.showSnackBar(const SnackBar(content: Text("Name removed")));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text("Couldn't remove name: $e")));
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final assets = await widget.client.assetsByPerson(widget.person.id);
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
    final title = _name ?? "Unnamed";
    return PopScope<Object?>(
      // Intercept the back gesture/button so we can hand the caller a
      // `_changed` flag — the People grid uses it as the refresh signal.
      // Without this, a rename here updated the local screen but the
      // grid still showed "Unnamed" on back-navigation.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          _merging
              ? const Padding(
                  padding: EdgeInsets.all(14),
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              // Phase 3 (faces/UX) — Rename + Remove-name alongside Merge.
              : PopupMenuButton<String>(
                  tooltip: "Person actions",
                  onSelected: (v) {
                    switch (v) {
                      case "rename":
                        _rename();
                        break;
                      case "remove":
                        _removeName();
                        break;
                      case "merge":
                        _pickAndMerge();
                        break;
                    }
                  },
                  itemBuilder: (_) => [
                    const PopupMenuItem(
                      value: "rename",
                      child: ListTile(
                        leading: Icon(Icons.edit_outlined),
                        title: Text("Rename"),
                      ),
                    ),
                    if (_name != null)
                      const PopupMenuItem(
                        value: "remove",
                        child: ListTile(
                          leading: Icon(Icons.label_off_outlined),
                          title: Text("Remove name"),
                        ),
                      ),
                    const PopupMenuItem(
                      value: "merge",
                      child: ListTile(
                        leading: Icon(Icons.merge_type),
                        title: Text("Merge into…"),
                      ),
                    ),
                  ],
                ),
        ],
      ),
      body: _stateScaffold(
        loading: _loading,
        error: _error,
        isEmpty: _assets.isEmpty,
        emptyText: "No photos found for this person.",
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
                  onPersonUpdated: (p) {
                    // Phase 3 (faces/UX) — propagate even when the name was
                    // CLEARED (p.name == null). The old `p.name != null` guard
                    // made a removed name invisible to the grid.
                    if (p.id == widget.person.id) {
                      setState(() => _name = p.name);
                      Navigator.of(context).pop(true);
                    }
                  },
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
      ),
    );
  }
}

/// Tiny pill that summarises an embedding-distance score for the Merge
/// picker. Bands mirror the face-suggestion thresholds in
/// `lib/faces/propagate.ts` so the language stays consistent across UI.
class _LikelihoodBadge extends StatelessWidget {
  const _LikelihoodBadge({required this.distance});
  final double distance;

  @override
  Widget build(BuildContext context) {
    final (label, color) = distance <= 0.26
        ? ("Very likely", Colors.green)
        : distance <= 0.32
            ? ("Likely", Colors.amber)
            : distance <= 0.45
                ? ("Possible", Colors.lightBlue)
                : ("Maybe", Colors.grey);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w600,
          color: color.shade800,
        ),
      ),
    );
  }
}

/// Bottom-sheet picker for "Merge into…". A TextField at the top filters
/// both the ranked likely-matches list and the named-people list as the
/// user types. Unnamed clusters never appear here — the caller filters
/// them out before constructing this widget.
class _MergePicker extends StatefulWidget {
  const _MergePicker({required this.candidates, required this.others});
  final List<MergeCandidate> candidates;
  final List<Person> others;

  @override
  State<_MergePicker> createState() => _MergePickerState();
}

class _MergePickerState extends State<_MergePicker> {
  String _query = "";

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final cand = q.isEmpty
        ? widget.candidates
        : widget.candidates
            .where((c) => (c.person.name ?? "").toLowerCase().contains(q))
            .toList();
    final rest = q.isEmpty
        ? widget.others
        : widget.others
            .where((p) => (p.name ?? "").toLowerCase().contains(q))
            .toList();
    final empty = cand.isEmpty && rest.isEmpty;

    return SafeArea(
      child: Padding(
        // Lift content above the keyboard so the search field stays usable.
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  "Merge into…",
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: TextField(
                autofocus: true,
                onChanged: (v) => setState(() => _query = v),
                decoration: const InputDecoration(
                  hintText: "Type a name…",
                  prefixIcon: Icon(Icons.search),
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
            Flexible(
              child: empty
                  ? Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        q.isEmpty
                            ? "No named people to merge into yet."
                            : "No matches for \"$_query\".",
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.grey),
                      ),
                    )
                  : ListView(
                      shrinkWrap: true,
                      children: [
                        if (cand.isNotEmpty) ...[
                          const Padding(
                            padding: EdgeInsets.fromLTRB(16, 0, 16, 6),
                            child: Text(
                              "LIKELY MATCHES",
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: Colors.grey,
                              ),
                            ),
                          ),
                          for (final c in cand)
                            ListTile(
                              leading: const Icon(
                                Icons.auto_awesome,
                                color: Colors.amber,
                              ),
                              title: Text(c.person.name!),
                              subtitle: Text(
                                "${c.person.instanceCount} faces",
                              ),
                              trailing:
                                  _LikelihoodBadge(distance: c.distance),
                              onTap: () =>
                                  Navigator.of(context).pop(c.person),
                            ),
                          if (rest.isNotEmpty) const Divider(),
                        ],
                        if (rest.isNotEmpty)
                          const Padding(
                            padding: EdgeInsets.fromLTRB(16, 6, 16, 6),
                            child: Text(
                              "ALL PEOPLE",
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: Colors.grey,
                              ),
                            ),
                          ),
                        for (final p in rest)
                          ListTile(
                            leading: const Icon(Icons.person_outline),
                            title: Text(p.name!),
                            subtitle: Text("${p.instanceCount} faces"),
                            onTap: () => Navigator.of(context).pop(p),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
