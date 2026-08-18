// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Lightweight filtered library view. Opened from the Collections screen's
// utility tiles (Favorites/Trash/Screenshots/Archive/Documents) and place
// cards. Hits the same /api/v1/assets endpoint as the main timeline but
// with a single filter pinned (favorite=1, kind=screenshot, place=…, etc.).
// Intentionally simpler than home_screen.dart: 3-col grid, keyset
// pagination, no scrubber. Full timeline parity is a follow-up if needed.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";
import "../widgets/live_badge.dart";
import "asset_detail_screen.dart";

class FilteredAssetsScreen extends StatefulWidget {
  const FilteredAssetsScreen({
    super.key,
    required this.client,
    required this.title,
    this.favorite = false,
    this.kind,
    this.lifecycle,
    this.place,
    this.shootId,
    this.scope,
  });

  final FontoClient client;
  final String title;
  final bool favorite;
  final String? kind;
  final String? lifecycle;
  final String? place;
  // ADR 0008/0009 — browse a single shoot's assets (shootId) and/or a scope
  // partition. Used by the Shoots screen to open SHOOT-scoped grids.
  final String? shootId;
  final String? scope;

  @override
  State<FilteredAssetsScreen> createState() => _FilteredAssetsScreenState();
}

class _FilteredAssetsScreenState extends State<FilteredAssetsScreen> {
  static const _pageSize = 60;

  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  final List<Asset> _assets = [];
  final Map<String, String> _thumbs = {};
  AssetCursor? _cursor;
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
    _load(reset: true);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  // Auto-paginate as the grid nears its tail — parity with home_screen.dart
  // (no tap-to-load tile).
  void _maybeLoadMore() {
    if (!_scroll.hasClients) return;
    if (_scroll.position.pixels < _scroll.position.maxScrollExtent - 600) return;
    if (_loading || _loadingMore || _cursor == null) return;
    _load(reset: false);
  }

  Future<void> _load({required bool reset}) async {
    if (reset) {
      setState(() {
        _loading = true;
        _error = null;
      });
    } else {
      if (_loadingMore || _cursor == null) return;
      setState(() => _loadingMore = true);
    }

    try {
      final page = await widget.client.listAssets(
        limit: _pageSize,
        after: reset ? null : _cursor,
        favorite: widget.favorite,
        kind: widget.kind,
        lifecycle: widget.lifecycle,
        place: widget.place,
        shootId: widget.shootId,
        scope: widget.scope,
      );
      if (!mounted) return;

      // Batch-resolve thumb URLs for this page's IDs.
      Map<String, String> urls = const {};
      if (page.assets.isNotEmpty) {
        try {
          urls = await widget.client.assetUrls(
            page.assets.map((a) => a.id).toList(),
          );
        } catch (_) {
          urls = const {};
        }
        if (!mounted) return;
      }

      setState(() {
        if (reset) {
          _assets
            ..clear()
            ..addAll(page.assets);
          _thumbs
            ..clear()
            ..addAll(urls);
        } else {
          _assets.addAll(page.assets);
          _thumbs.addAll(urls);
        }
        _cursor = page.nextCursor;
        _loading = false;
        _loadingMore = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}", reset: reset);
    } catch (e) {
      _fail(e.toString(), reset: reset);
    }
  }

  void _fail(String msg, {required bool reset}) {
    if (!mounted) return;
    // A failed "load more" must not discard the pages already on screen (and
    // the scroll position). Keep the grid, surface a retriable snackbar, and
    // only fall back to the full-screen error state on the initial load.
    if (!reset) {
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text("Couldn't load more. Check your connection."),
          action: SnackBarAction(
            label: "Retry",
            onPressed: () => _load(reset: false),
          ),
        ),
      );
      return;
    }
    setState(() {
      _error = msg;
      _loading = false;
      _loadingMore = false;
    });
  }

  Future<void> _openDetail(int i) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>?>(
      MaterialPageRoute(
        builder: (_) => AssetDetailScreen(
          client: widget.client,
          assets: _assets,
          initialIndex: i,
        ),
      ),
    );
    if (!mounted || result == null) return;
    final trashedId = result["trashedId"] as String?;
    if (trashedId != null) {
      setState(() => _assets.removeWhere((a) => a.id == trashedId));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: _buildBody(),
    );
  }

  bool get _hasFilter =>
      widget.favorite ||
      widget.kind != null ||
      (widget.lifecycle != null && widget.lifecycle != "active") ||
      widget.place != null;

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return ListErrorState(onRetry: () => _load(reset: true));
    }
    if (_assets.isEmpty) {
      // Mirrors the web filter-aware empty state. When a filter is pinned
      // (this surface always opens w/ at least one) the copy points the
      // user to clearing it via the back button — there's no in-page
      // filter UI here, so the CTA pops to Collections.
      return ListEmptyState(
        message: _hasFilter
            ? filteredEmptyForKind(widget.kind)
            : defaultEmptyForKind(widget.kind),
        filtered: _hasFilter,
        onClearFilters: _hasFilter ? () => Navigator.of(context).pop() : null,
      );
    }

    return RefreshIndicator(
      onRefresh: () => _load(reset: true),
      child: GridView.builder(
        controller: _scroll,
        padding: const EdgeInsets.all(2),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          mainAxisSpacing: 2,
          crossAxisSpacing: 2,
        ),
        itemCount: _assets.length + (_loadingMore ? 1 : 0),
        itemBuilder: (context, i) {
          if (i >= _assets.length) {
            // Tail loader only — pagination is driven by the scroll listener.
            return const ColoredBox(
              color: Colors.transparent,
              child: Center(
                child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            );
          }
          final a = _assets[i];
          final url = _thumbs[a.id];
          final tile = url == null
              ? imageSkeleton(context)
              : CachedNetworkImage(
                  imageUrl: url,
                  fit: BoxFit.cover,
                  memCacheWidth: 260,
                  memCacheHeight: 260,
                  placeholder: (ctx, _) => imageSkeleton(ctx),
                  errorWidget: (ctx, _, __) => ColoredBox(
                    color: Theme.of(ctx).colorScheme.surfaceContainerHighest,
                    child: const Icon(Icons.broken_image),
                  ),
                );
          return GestureDetector(
            onTap: () => _openDetail(i),
            // M12 / ADR 0014 — LIVE badge on motion-photo tiles (web parity).
            child: a.motionPhoto
                ? Stack(
                    fit: StackFit.expand,
                    children: [
                      tile,
                      const Positioned(
                        left: 4,
                        top: 4,
                        child: LiveBadge(compact: true),
                      ),
                    ],
                  )
                : tile,
          );
        },
      ),
    );
  }
}
