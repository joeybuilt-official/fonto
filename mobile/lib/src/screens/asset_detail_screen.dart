// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Full-screen asset viewer. PageView between assets (left/right swipe),
// PhotoView per page (pinch + pan + double-tap zoom). AppBar actions:
// favorite toggle, trash, native share. Preview-variant URLs fetched
// lazily as the user scrolls — keeps the initial route push cheap.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";
import "package:photo_view/photo_view.dart";
import "package:photo_view/photo_view_gallery.dart";
import "package:share_plus/share_plus.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";

class AssetDetailScreen extends StatefulWidget {
  const AssetDetailScreen({
    super.key,
    required this.client,
    required this.assets,
    required this.initialIndex,
  });

  final FontoClient client;
  final List<Asset> assets;
  final int initialIndex;

  @override
  State<AssetDetailScreen> createState() => _AssetDetailScreenState();
}

class _AssetDetailScreenState extends State<AssetDetailScreen> {
  late final PageController _page =
      PageController(initialPage: widget.initialIndex);
  late final List<Asset> _assets = List.of(widget.assets);
  late int _index = widget.initialIndex;
  final Map<String, String> _previews = {};
  bool _acting = false;

  Asset get _cur => _assets[_index];

  @override
  void initState() {
    super.initState();
    _ensurePreviews(_index);
  }

  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  /// Fetch preview URLs for a window of ±3 around `i` in one batch.
  /// Cheap b/c assetUrls is batched server-side; skips ids already cached.
  Future<void> _ensurePreviews(int i) async {
    final lo = (i - 3).clamp(0, _assets.length - 1);
    final hi = (i + 3).clamp(0, _assets.length - 1);
    final ids = <String>[];
    for (var k = lo; k <= hi; k++) {
      final id = _assets[k].id;
      if (!_previews.containsKey(id)) ids.add(id);
    }
    if (ids.isEmpty) return;
    try {
      final batch = await widget.client.assetUrls(ids, variant: "preview");
      if (!mounted) return;
      setState(() => _previews.addAll(batch));
    } catch (_) {
      // Silent — placeholder will render. Asset is still usable via thumb.
    }
  }

  void _onPageChanged(int i) {
    setState(() => _index = i);
    _ensurePreviews(i);
  }

  Future<void> _toggleFavorite() async {
    if (_acting) return;
    setState(() => _acting = true);
    final next = !(_cur.isFavorite ?? false);
    try {
      final updated = await widget.client.setFavorite(_cur.id, next);
      if (!mounted) return;
      setState(() => _assets[_index] = updated);
    } on ApiException catch (e) {
      _snack("Favorite failed: ${e.status} ${e.message}");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _confirmTrash() async {
    if (_acting) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Move to trash?"),
        content: Text('"${_cur.filename}" will be moved to trash.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text("Cancel"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text("Move to trash"),
          ),
        ],
      ),
    );
    if (ok == true) await _trash();
  }

  Future<void> _trash() async {
    if (_acting) return;
    setState(() => _acting = true);
    try {
      await widget.client.trashAsset(_cur.id);
      if (!mounted) return;
      // Pop with the trashed id so the caller can drop it from the grid.
      Navigator.of(context).pop(<String, dynamic>{
        "trashedId": _cur.id,
      });
    } on ApiException catch (e) {
      _snack("Trash failed: ${e.status} ${e.message}");
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _share() async {
    if (_acting) return;
    setState(() => _acting = true);
    try {
      final url = await widget.client.createAssetShare(_cur.id);
      if (!mounted) return;
      await Share.share(url, subject: _cur.filename);
    } on ApiException catch (e) {
      _snack("Share failed: ${e.status} ${e.message}");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          _cur.filename,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 14),
        ),
        actions: [
          IconButton(
            tooltip: (_cur.isFavorite ?? false) ? "Unfavorite" : "Favorite",
            icon: Icon(
              (_cur.isFavorite ?? false) ? Icons.star : Icons.star_border,
            ),
            onPressed: _acting ? null : _toggleFavorite,
          ),
          IconButton(
            tooltip: "Share",
            icon: const Icon(Icons.ios_share),
            onPressed: _acting ? null : _share,
          ),
          IconButton(
            tooltip: "Trash",
            icon: const Icon(Icons.delete_outline),
            onPressed: _acting ? null : _confirmTrash,
          ),
        ],
      ),
      body: PhotoViewGallery.builder(
        pageController: _page,
        itemCount: _assets.length,
        onPageChanged: _onPageChanged,
        backgroundDecoration: const BoxDecoration(color: Colors.black),
        loadingBuilder: (_, __) =>
            const Center(child: CircularProgressIndicator()),
        builder: (context, i) {
          final a = _assets[i];
          final url = _previews[a.id];
          return PhotoViewGalleryPageOptions.customChild(
            child: url == null
                ? const Center(child: CircularProgressIndicator())
                : CachedNetworkImage(
                    imageUrl: url,
                    fit: BoxFit.contain,
                    placeholder: (_, __) => const Center(
                      child: CircularProgressIndicator(),
                    ),
                    errorWidget: (_, __, ___) => const Icon(
                      Icons.broken_image,
                      color: Colors.white,
                      size: 48,
                    ),
                  ),
            minScale: PhotoViewComputedScale.contained,
            maxScale: PhotoViewComputedScale.covered * 4,
            heroAttributes: PhotoViewHeroAttributes(tag: a.id),
          );
        },
      ),
    );
  }
}
