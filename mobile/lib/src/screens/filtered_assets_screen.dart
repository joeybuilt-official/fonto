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

  @override
  void initState() {
    super.initState();
    _load(reset: true);
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
    // A failed page 2 must not wipe the 60 assets already on screen. Only the
    // first load owns the full-page error state; a load-more failure keeps the
    // grid and reports itself in a SnackBar, leaving the "+" tile to retry.
    if (!reset) {
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't load more: $msg")),
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
      // Keep the row for Undo: `_load(reset: true)` only refetches the first
      // page, so a restore outside it would leave "Restored." claiming
      // something the user can't see.
      final removed = _assets.cast<Asset?>().firstWhere(
            (a) => a?.id == trashedId,
            orElse: () => null,
          );
      setState(() => _assets.removeWhere((a) => a.id == trashedId));
      if (!_undoable) return;
      // Confirm the destructive write and offer its inverse; the tile silently
      // disappearing was the only signal the user got. The messenger is
      // captured here because a SnackBar is owned above the route and can
      // outlive this State.
      final messenger = ScaffoldMessenger.of(context);
      messenger.showSnackBar(
        SnackBar(
          content: const Text("Moved to trash."),
          action: SnackBarAction(
            label: "Undo",
            onPressed: () => _restoreTrashed(trashedId, messenger, removed),
          ),
        ),
      );
    }
  }

  /// Whether "Moved to trash." + Undo is honest on this surface.
  ///
  /// It isn't on the lifecycle-pinned grids. From Trash the trash write is a
  /// no-op on an already-trashed asset, so the message would be wrong; from
  /// Archive, `restore` lands the asset in `active` rather than back in this
  /// grid, so Undo would silently de-archive it while the tile reappeared
  /// under an "Archive" title. Those surfaces keep the previous behaviour —
  /// the tile is removed and nothing is claimed.
  bool get _undoable =>
      widget.lifecycle == null || widget.lifecycle == "active";

  Future<void> _restoreTrashed(
    String id,
    ScaffoldMessengerState messenger,
    Asset? removed,
  ) async {
    try {
      await widget.client.restoreAsset(id);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't restore: $e")));
      return;
    }
    messenger.showSnackBar(const SnackBar(content: Text("Restored.")));
    if (!mounted) return;
    // Re-derive the slot from the sort key; a pull-to-refresh may have
    // rewritten the list while the SnackBar was up.
    if (removed != null && !_assets.any((a) => a.id == id)) {
      final key = removed.capturedAt ?? removed.createdAt;
      var at = _assets.indexWhere(
        (a) => (a.capturedAt ?? a.createdAt).isBefore(key),
      );
      if (at < 0) at = _assets.length;
      setState(() => _assets.insert(at, removed));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: _buildBody(),
    );
  }

  /// Copy for an empty grid. `kind` only describes the lens surfaces, so
  /// Favorites / Trash / Archive / shoots / place cards used to fall through
  /// to the generic "No assets match these filters." Web names each one
  /// (e.g. trash/page.tsx: "Trash is empty."), so mobile does too.
  (String, IconData) get _emptyState {
    if (widget.lifecycle == "trashed") {
      return ("Trash is empty.", Icons.delete_outline);
    }
    if (widget.lifecycle == "archived") {
      return ("Nothing archived yet.", Icons.archive_outlined);
    }
    if (widget.favorite) {
      return ("No favorites yet.", Icons.star_border);
    }
    final place = widget.place;
    if (place != null) {
      return ("No photos from $place.", Icons.place_outlined);
    }
    if (widget.shootId != null) {
      return ("No assets in this shoot yet.", Icons.camera_alt_outlined);
    }
    return (
      filteredEmptyForKind(widget.kind),
      Icons.photo_library_outlined,
    );
  }

  Widget _buildBody() {
    if (_loading) {
      // Placeholder tiles on the same 3-col/2px lattice the grid below uses,
      // instead of a spinner in blank space — parity with web's GridSkeleton.
      return const GridSkeleton(
        spacing: 2,
        padding: EdgeInsets.all(2),
      );
    }
    if (_error != null) {
      return ListErrorState(onRetry: () => _load(reset: true));
    }
    if (_assets.isEmpty) {
      // No CTA here: every entry point to this screen is a push, so the
      // AppBar back arrow is the recovery. The old "Clear filters" button
      // just popped the route, which is not what its label promised.
      final (message, icon) = _emptyState;
      return ListEmptyState(message: message, icon: icon);
    }

    return RefreshIndicator(
      onRefresh: () => _load(reset: true),
      child: GridView.builder(
        padding: const EdgeInsets.all(2),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          mainAxisSpacing: 2,
          crossAxisSpacing: 2,
        ),
        itemCount: _assets.length + (_cursor != null ? 1 : 0),
        itemBuilder: (context, i) {
          if (i >= _assets.length) {
            return _LoadMoreTile(
              loading: _loadingMore,
              onTap: () => _load(reset: false),
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

class _LoadMoreTile extends StatelessWidget {
  const _LoadMoreTile({required this.loading, required this.onTap});
  final bool loading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: loading ? null : onTap,
      child: Container(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        child: Center(
          child: loading
              ? const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.add),
        ),
      ),
    );
  }
}
