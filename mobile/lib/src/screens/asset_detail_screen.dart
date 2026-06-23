// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Full-screen asset viewer. PageView between assets (left/right swipe),
// PhotoView per page (pinch + pan + double-tap zoom). AppBar actions:
// favorite toggle, trash, native share. Preview-variant URLs fetched
// lazily as the user scrolls — keeps the initial route push cheap.

import "dart:async" show Timer;
import "dart:math" show min, max;
import "dart:typed_data" show Uint8List;
import "dart:ui" as ui show instantiateImageCodec;

import "package:cached_network_image/cached_network_image.dart";
import "package:crop_your_image/crop_your_image.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:photo_view/photo_view.dart";
import "package:photo_view/photo_view_gallery.dart";
import "package:share_plus/share_plus.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../state/asset_cache.dart";
import "../state/offline_cache.dart";
import "../state/pending_mutations.dart";
import "../widgets/asset_video_player.dart";

class AssetDetailScreen extends StatefulWidget {
  const AssetDetailScreen({
    super.key,
    required this.client,
    required this.assets,
    required this.initialIndex,
    this.onPersonUpdated,
  });

  final FontoClient client;
  final List<Asset> assets;
  final int initialIndex;
  /// Called whenever a person is created or renamed from within this screen.
  final void Function(Person)? onPersonUpdated;

  @override
  State<AssetDetailScreen> createState() => _AssetDetailScreenState();
}

class _AssetDetailScreenState extends State<AssetDetailScreen> {
  late final PageController _page =
      PageController(initialPage: widget.initialIndex);
  late final List<Asset> _assets = List.of(widget.assets);
  late int _index = widget.initialIndex;
  final Map<String, String> _previews = {};
  // Ids whose preview-url fetch failed; lets us render a retry affordance
  // instead of an infinite spinner.
  final Set<String> _previewFailed = {};
  // Phase 6.12 — extracted text layer for text/code assets, fetched lazily
  // from the per-asset detail endpoint as the user scrolls onto one.
  final Map<String, String> _texts = {};
  bool _acting = false;
  // Faces for the current asset (and ±neighbors as the user pages) +
  // a single bool that toggles the overlay on a tap of the image.
  // `null` = not yet fetched; `const []` = fetched, no faces. Reuse the
  // bool across page swipes — taps consistently flip the same flag.
  final Map<String, List<AssetFace>?> _facesByAsset = {};
  bool _showFaceLabels = false;
  // M8 — slideshow auto-advance. Advances one page every SLIDESHOW dwell;
  // stops automatically at the last asset.
  static const Duration _slideshowDwell = Duration(seconds: 4);
  bool _slideshow = false;
  Timer? _slideTimer;

  static bool _isText(Asset a) => a.mimeType.startsWith("text/");
  static bool _isVideo(Asset a) => a.mimeType.startsWith("video/");

  Asset get _cur => _assets[_index];

  @override
  void initState() {
    super.initState();
    _ensurePreviews(_index);
    _ensureText(_index);
    _ensureFaces(_index);
  }

  @override
  void dispose() {
    _slideTimer?.cancel();
    _page.dispose();
    super.dispose();
  }

  // M8 — slideshow controls.
  void _toggleSlideshow() {
    if (_slideshow) {
      _stopSlideshow();
      return;
    }
    if (_index >= _assets.length - 1) return;
    setState(() => _slideshow = true);
    _slideTimer = Timer.periodic(_slideshowDwell, (_) {
      if (_index >= _assets.length - 1) {
        _stopSlideshow();
        return;
      }
      _page.nextPage(
        duration: const Duration(milliseconds: 350),
        curve: Curves.easeInOut,
      );
    });
  }

  void _stopSlideshow() {
    _slideTimer?.cancel();
    _slideTimer = null;
    if (mounted) setState(() => _slideshow = false);
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
      setState(() {
        _previews.addAll(batch);
        _previewFailed.removeAll(ids);
      });
    } catch (_) {
      // Offline / fetch failed: fall back to the last-known signed URLs the
      // AssetCache persisted for these ids (preview if we have it, else the
      // thumb). The image layer keys its disk cache by asset id, so the warmed
      // bytes still render even though the signed URL itself is stale. Only the
      // ids with no cached URL stay "failed" (→ retry affordance).
      final cached = await _cachedUrls(ids);
      if (!mounted) return;
      setState(() {
        _previews.addAll(cached);
        _previewFailed.addAll(ids.where((id) => !cached.containsKey(id)));
      });
    }
  }

  /// Pull the last-known preview/thumb URLs for [ids] from the on-device
  /// AssetCache. Best-effort — returns whatever's cached. Used when the live
  /// preview-URL fetch fails so a viewer opened offline still shows an image.
  Future<Map<String, String>> _cachedUrls(List<String> ids) async {
    final out = <String, String>{};
    try {
      final cache = await AssetCache.open();
      for (final id in ids) {
        final url = await cache.urlForAsset(id);
        if (url != null) out[id] = url;
      }
    } catch (_) {
      // No cache / read error — leave empty so the ids show the retry state.
    }
    return out;
  }

  void _onPageChanged(int i) {
    setState(() => _index = i);
    _ensurePreviews(i);
    _ensureText(i);
    _ensureFaces(i);
  }

  /// Lazy-load the face list for asset `i`. Skips non-images and ids
  /// already cached. Stores `const []` for an empty result (so we don't
  /// refetch on every tap); on failure the marker is dropped so a later
  /// visit re-fetches.
  Future<void> _ensureFaces(int i) async {
    final a = _assets[i];
    if (!a.mimeType.startsWith("image/")) return;
    if (_facesByAsset.containsKey(a.id)) return;
    _facesByAsset[a.id] = null; // mark in-flight
    try {
      final faces = await widget.client.assetFaces(a.id);
      if (!mounted) return;
      setState(() => _facesByAsset[a.id] = faces);
    } catch (_) {
      if (!mounted) return;
      // Don't cache empty-on-error: drop the in-flight marker so a later
      // page-swipe back onto this asset re-fetches instead of showing
      // a permanently faceless result.
      setState(() => _facesByAsset.remove(a.id));
    }
  }

  /// Fetch the text layer for a text/code asset on demand. No-op for media
  /// assets or ids already cached.
  Future<void> _ensureText(int i) async {
    final a = _assets[i];
    if (!_isText(a) || _texts.containsKey(a.id)) return;
    try {
      final full = await widget.client.getAsset(a.id);
      if (!mounted) return;
      setState(() => _texts[a.id] = full.ocrText ?? "");
    } catch (_) {
      if (!mounted) return;
      setState(() => _texts[a.id] = "");
    }
  }

  Future<void> _toggleFavorite() async {
    if (_acting) return;
    setState(() => _acting = true);
    final id = _cur.id;
    final next = !(_cur.isFavorite ?? false);
    try {
      final updated = await widget.client.setFavorite(id, next);
      if (!mounted) return;
      setState(() => _assets[_index] = updated);
    } on ApiException catch (e) {
      // A 4xx is a real server rejection — surface it. Anything else is
      // treated as a transient/offline failure and queued for replay.
      if (e.status >= 400 && e.status < 500) {
        _snack("Favorite failed: ${e.status} ${e.message}");
      } else {
        await _queueFavoriteOffline(id, next);
      }
    } catch (_) {
      // Network down — optimistic + queued replay on reconnect.
      await _queueFavoriteOffline(id, next);
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  /// Offline favorite: optimistically flip the local row and persist the edit
  /// to the pending-mutations queue, which replays on reconnect.
  Future<void> _queueFavoriteOffline(String id, bool next) async {
    try {
      final q = await PendingMutations.open();
      await q.enqueue(
        assetId: id,
        field: "isFavorite",
        value: next ? "true" : "false",
      );
    } catch (_) {
      // Queue write failed — still reflect the change locally.
    }
    if (!mounted) return;
    final i = _assets.indexWhere((a) => a.id == id);
    if (i >= 0) {
      setState(() => _assets[i] = _assets[i].copyWith(isFavorite: next));
    }
    _snack("Saved offline — will sync when you're back online.");
  }

  Future<void> _reprocess() async {
    if (_acting) return;
    setState(() => _acting = true);
    try {
      await widget.client.reprocessAsset(_cur.id);
      if (!mounted) return;
      _snack("Re-scan queued — recognition will refresh shortly.");
    } on ApiException catch (e) {
      _snack("Re-scan failed: ${e.status} ${e.message}");
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

  /// Task #34 — rotate the current asset in place by [degrees] (CW positive).
  /// Server reuses the same id, so we just bust the image cache + refetch the
  /// preview URL so the new pixels show. Faces + thumbnails regenerate
  /// asynchronously on the worker.
  Future<void> _rotate(int degrees) async {
    if (_acting) return;
    if (!_cur.mimeType.startsWith("image/")) return;
    setState(() => _acting = true);
    final id = _cur.id;
    try {
      await widget.client.transformRotate(id, degrees);
      if (!mounted) return;
      // Refresh preview URL + drop the cached image so the next paint pulls
      // the rotated pixels. The face overlay is invalidated for the same id.
      await CachedNetworkImage.evictFromCache(_previews[id] ?? "");
      setState(() {
        _previews.remove(id);
        _previewFailed.remove(id);
        _facesByAsset.remove(id);
      });
      await _ensurePreviews(_index);
      await _ensureFaces(_index);
      // Pull the freshly-rotated asset row so width/height swap is reflected
      // in the face overlay's coordinate mapping.
      try {
        final fresh = await widget.client.getAsset(id);
        if (!mounted) return;
        setState(() => _assets[_index] = fresh);
      } catch (_) {
        /* refresh is best-effort */
      }
      if (!mounted) return;
      _snack("Rotated");
    } on ApiException catch (e) {
      _snack("Rotate failed: ${e.status} ${e.message}");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  /// Task #34 — open the in-app cropper on the original bytes, POST the
  /// resulting normalised rect to /transform, and navigate to the new asset.
  /// Crops are always destructive on the server (`asNew=true`), so we mirror
  /// the open-by-id navigation pattern used elsewhere.
  Future<void> _crop() async {
    if (_acting) return;
    final a = _cur;
    if (!a.mimeType.startsWith("image/")) return;
    setState(() => _acting = true);
    try {
      // 1. Resolve original signed URL + pull bytes into memory. The cropper
      //    needs the source bytes; we don't persist them to disk.
      final urls = await widget.client.assetUrls([a.id], variant: "original");
      final url = urls[a.id];
      if (url == null) {
        throw ApiException(404, "Original URL unavailable");
      }
      final res = await http.get(Uri.parse(url));
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, "Couldn't download original");
      }
      if (!mounted) return;
      // 2. Push the cropper sheet. Returns the source-pixel rect the user
      //    picked, or null on cancel.
      final rect = await Navigator.of(context).push<Rect?>(
        MaterialPageRoute<Rect?>(
          fullscreenDialog: true,
          builder: (_) => _CropScreen(bytes: res.bodyBytes),
        ),
      );
      if (rect == null || !mounted) return;

      // 3. Convert pixel rect → normalised (0..1). Source dims come from the
      //    server-side metadata when available, otherwise we decode the bytes
      //    we already have in hand.
      Size? src;
      if (a.widthPx != null && a.heightPx != null) {
        src = Size(a.widthPx!.toDouble(), a.heightPx!.toDouble());
      } else {
        src = await _decodeImageSize(res.bodyBytes);
      }
      if (src == null) {
        throw ApiException(500, "Couldn't measure source");
      }
      final nx = (rect.left / src.width).clamp(0.0, 1.0);
      final ny = (rect.top / src.height).clamp(0.0, 1.0);
      final nw = (rect.width / src.width).clamp(0.0, 1.0 - nx);
      final nh = (rect.height / src.height).clamp(0.0, 1.0 - ny);
      if (nw <= 0 || nh <= 0) {
        throw ApiException(400, "Crop rect is empty");
      }
      final newId = await widget.client.transformCrop(a.id, nx, ny, nw, nh);

      if (!mounted) return;
      _snack("Saved cropped copy");
      // 4. Mirror the open-by-id navigation used elsewhere in the app.
      final fresh = await widget.client.getAsset(newId);
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => AssetDetailScreen(
            client: widget.client,
            assets: [fresh],
            initialIndex: 0,
            onPersonUpdated: widget.onPersonUpdated,
          ),
        ),
      );
    } on ApiException catch (e) {
      _snack("Crop failed: ${e.status} ${e.message}");
    } catch (e) {
      _snack("Crop failed: $e");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  /// Decode just enough of [bytes] to recover image dimensions, using the
  /// Flutter image pipeline (no extra deps).
  Future<Size?> _decodeImageSize(List<int> bytes) async {
    try {
      final codec = await ui.instantiateImageCodec(
        bytes is Uint8List ? bytes : Uint8List.fromList(bytes),
      );
      final frame = await codec.getNextFrame();
      final img = frame.image;
      final size = Size(img.width.toDouble(), img.height.toDouble());
      img.dispose();
      return size;
    } catch (_) {
      return null;
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

  void _showFaceTagger() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => _FaceTaggingScreen(
        client: widget.client,
        asset: _cur,
        imageUrl: _previews[_cur.id],
        onPersonUpdated: widget.onPersonUpdated,
      ),
    ));
  }

  String _fmtSize(int bytes) {
    if (bytes <= 0) return "—";
    if (bytes < 1024) return "$bytes B";
    if (bytes < 1024 * 1024) return "${(bytes / 1024).toStringAsFixed(0)} KB";
    if (bytes < 1024 * 1024 * 1024) {
      return "${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB";
    }
    return "${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB";
  }

  String _fmtDate(DateTime? d) {
    if (d == null) return "—";
    final l = d.toLocal();
    String two(int n) => n.toString().padLeft(2, "0");
    return "${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}";
  }

  void _showInfo() {
    final a = _cur;
    final rows = <(String, String)>[
      ("Filename", a.filename),
      ("Type", a.mimeType),
      ("Size", _fmtSize(a.sizeBytes)),
      if (a.classification != null && a.classification!.isNotEmpty)
        ("Category", a.classification!),
      if (a.directoryPath != null && a.directoryPath!.isNotEmpty)
        ("Folder", a.directoryPath!),
      if (a.capturedAt != null) ("Captured", _fmtDate(a.capturedAt)),
      if (a.rating != null && a.rating! > 0) ("Rating", "${a.rating} ★"),
      if (a.description != null && a.description!.isNotEmpty)
        ("Description", a.description!),
    ];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                "Details",
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 12),
              ...rows.map(
                (r) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 96,
                        child: Text(
                          r.$1,
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: Theme.of(context).colorScheme.outline,
                              ),
                        ),
                      ),
                      Expanded(
                        child: Text(r.$2, style: Theme.of(context).textTheme.bodySmall),
                      ),
                    ],
                  ),
                ),
              ),
              if (a.mimeType.startsWith("image/"))
                _SimilarStrip(
                  client: widget.client,
                  assetId: a.id,
                  onTap: (asset) {
                    Navigator.of(context).pop(); // close sheet
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => AssetDetailScreen(
                          client: widget.client,
                          assets: [asset],
                          initialIndex: 0,
                        ),
                      ),
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Photo viewer chrome stays intentionally black/white — photo content
    // reads best on a dark surround regardless of system theme.
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          _cur.filename,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Colors.white),
        ),
        actions: [
          if (_cur.mimeType.startsWith("image/"))
            IconButton(
              tooltip: "Tag people",
              icon: const Icon(Icons.face_outlined),
              onPressed: () => _showFaceTagger(),
            ),
          // Task #34 — rotate + crop live behind an Edit overflow so the
          // toolbar doesn't sprout four more icons. Image-only.
          if (_cur.mimeType.startsWith("image/"))
            PopupMenuButton<String>(
              tooltip: "Edit",
              icon: const Icon(Icons.tune),
              enabled: !_acting,
              onSelected: (v) {
                switch (v) {
                  case "rotate_ccw":
                    _rotate(-90);
                    break;
                  case "rotate_cw":
                    _rotate(90);
                    break;
                  case "rotate_180":
                    _rotate(180);
                    break;
                  case "crop":
                    _crop();
                    break;
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: "rotate_ccw",
                  child: ListTile(
                    leading: Icon(Icons.rotate_left),
                    title: Text("Rotate left"),
                  ),
                ),
                PopupMenuItem(
                  value: "rotate_cw",
                  child: ListTile(
                    leading: Icon(Icons.rotate_right),
                    title: Text("Rotate right"),
                  ),
                ),
                PopupMenuItem(
                  value: "rotate_180",
                  child: ListTile(
                    leading: Icon(Icons.flip_camera_android),
                    title: Text("Rotate 180°"),
                  ),
                ),
                PopupMenuDivider(),
                PopupMenuItem(
                  value: "crop",
                  child: ListTile(
                    leading: Icon(Icons.crop),
                    title: Text("Crop…"),
                  ),
                ),
              ],
            ),
          if (_assets.length > 1)
            IconButton(
              tooltip: _slideshow ? "Pause slideshow" : "Play slideshow",
              icon: Icon(
                _slideshow
                    ? Icons.pause_circle_outline
                    : Icons.play_circle_outline,
              ),
              onPressed: _toggleSlideshow,
            ),
          IconButton(
            tooltip: "Info",
            icon: const Icon(Icons.info_outline),
            onPressed: _showInfo,
          ),
          IconButton(
            tooltip: (_cur.isFavorite ?? false) ? "Unfavorite" : "Favorite",
            icon: Icon(
              (_cur.isFavorite ?? false) ? Icons.star : Icons.star_border,
            ),
            onPressed: _acting ? null : _toggleFavorite,
          ),
          IconButton(
            tooltip: "Re-scan (AI)",
            icon: const Icon(Icons.auto_awesome_outlined),
            onPressed: _acting ? null : _reprocess,
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
      body: Stack(
        fit: StackFit.expand,
        children: [
          PhotoViewGallery.builder(
            pageController: _page,
            itemCount: _assets.length,
            onPageChanged: _onPageChanged,
            backgroundDecoration: const BoxDecoration(color: Colors.black),
            loadingBuilder: (_, __) =>
                const Center(child: CircularProgressIndicator()),
            builder: (context, i) {
              final a = _assets[i];
              if (_isText(a)) {
                return PhotoViewGalleryPageOptions.customChild(
                  disableGestures: true,
                  child: _TextPage(
                    text: _texts[a.id],
                    code: a.mimeType != "text/plain",
                  ),
                );
              }
              if (_isVideo(a)) {
                // PhotoView gestures would swallow the player's tap/scrub —
                // disable them and let the player own the surface.
                return PhotoViewGalleryPageOptions.customChild(
                  disableGestures: true,
                  child: AssetVideoPlayer(client: widget.client, asset: a),
                );
              }
              final url = _previews[a.id];
              return PhotoViewGalleryPageOptions.customChild(
                child: url == null
                    ? (_previewFailed.contains(a.id)
                        ? Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(Icons.broken_image,
                                    color: Colors.white, size: 48),
                                const SizedBox(height: 12),
                                const Text("Couldn't load preview",
                                    style: TextStyle(color: Colors.white)),
                                const SizedBox(height: 8),
                                TextButton(
                                  onPressed: () {
                                    setState(
                                        () => _previewFailed.remove(a.id));
                                    _ensurePreviews(_index);
                                  },
                                  child: const Text("Retry"),
                                ),
                              ],
                            ),
                          )
                        : const Center(child: CircularProgressIndicator()))
                    : CachedNetworkImage(
                        imageUrl: url,
                        fit: BoxFit.contain,
                        memCacheWidth: 1920,
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
                // Single-tap toggles the face-label overlay. PhotoView's
                // own onTapUp fires AFTER its double-tap-zoom and
                // pinch-zoom paths, so neither gesture regresses.
                onTapUp: (_, __, ___) {
                  if (_isViewableImage(a)) {
                    setState(() => _showFaceLabels = !_showFaceLabels);
                  }
                },
              );
            },
          ),
          // IgnorePointer-wrapped overlay so PhotoView gestures aren't
          // intercepted. The overlay only paints when labels are on AND
          // we have faces + dims for the current image.
          if (_showFaceLabels) _buildFaceOverlay(),
        ],
      ),
    );
  }

  static bool _isViewableImage(Asset a) =>
      a.mimeType.startsWith("image/");

  Widget _buildFaceOverlay() {
    final a = _cur;
    if (!_isViewableImage(a)) return const SizedBox.shrink();
    final all = _facesByAsset[a.id];
    if (all == null) return const SizedBox.shrink();
    // Ignored faces drop out of the overlay so the user sees them disappear.
    final faces = all.where((f) => !f.hidden).toList();
    if (faces.isEmpty) return const SizedBox.shrink();
    final wPx = a.widthPx;
    final hPx = a.heightPx;
    if (wPx == null || hPx == null) return const SizedBox.shrink();
    final dims = Size(wPx.toDouble(), hPx.toDouble());
    return IgnorePointer(
      child: LayoutBuilder(builder: (ctx, constraints) {
        final ww = constraints.maxWidth;
        final wh = constraints.maxHeight;
        final s = min(ww / dims.width, wh / dims.height);
        final rx = (ww - dims.width * s) / 2;
        final ry = (wh - dims.height * s) / 2;
        return Stack(
          fit: StackFit.expand,
          children: faces.map((face) {
            final b = face.bbox;
            final left = rx + b.x * dims.width * s;
            final top = ry + b.y * dims.height * s;
            final fw = b.w * dims.width * s;
            final fh = b.h * dims.height * s;
            final d = max(fw, fh) + 12;
            final cx = left + fw / 2;
            final cy = top + fh / 2;
            return Positioned(
              left: cx - d / 2,
              top: cy - d / 2,
              width: d,
              height: d,
              child: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: face.personId != null
                        ? Theme.of(context).colorScheme.primary
                        : Colors.white70,
                    width: 2,
                  ),
                ),
                child: face.personName != null
                    ? Align(
                        alignment: Alignment.bottomCenter,
                        child: FractionalTranslation(
                          translation: const Offset(0, 1),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 4, vertical: 2),
                            decoration: BoxDecoration(
                              color: Colors.black54,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              face.personName!,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 10,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ),
                      )
                    : null,
              ),
            );
          }).toList(),
        );
      }),
    );
  }
}

// Phase 6.12 — scrollable monospace renderer for text/code assets. `text` is
// null while the detail fetch is in flight, "" when there's no content.
class _TextPage extends StatelessWidget {
  const _TextPage({required this.text, required this.code});

  final String? text;
  final bool code;

  @override
  Widget build(BuildContext context) {
    if (text == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (text!.isEmpty) {
      return const Center(
        child: Text(
          "No text content extracted",
          style: TextStyle(color: Colors.white54),
        ),
      );
    }
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: SelectableText(
          text!,
          style: TextStyle(
            color: Colors.white,
            fontFamily: "monospace",
            fontSize: code ? 13 : 14,
            height: code ? 1.35 : 1.5,
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Face tagging — static image overlay with tappable face circles.
// ---------------------------------------------------------------------------

class _FaceTaggingScreen extends StatefulWidget {
  const _FaceTaggingScreen({
    required this.client,
    required this.asset,
    this.imageUrl,
    this.onPersonUpdated,
  });

  final FontoClient client;
  final Asset asset;
  final String? imageUrl;
  final void Function(Person)? onPersonUpdated;

  @override
  State<_FaceTaggingScreen> createState() => _FaceTaggingScreenState();
}

class _FaceTaggingScreenState extends State<_FaceTaggingScreen> {
  bool _loading = true;
  String? _error;
  List<AssetFace> _faces = const [];
  List<Person> _persons = const [];
  String? _resolvedUrl;
  Size? _imageDims;
  bool _showNames = true;

  // Face navigation + zoom
  int _activeFaceIndex = 0;
  final TransformationController _transformController = TransformationController();
  // Set by LayoutBuilder on every build — used for zoom calculation.
  Size _containerSize = Size.zero;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _transformController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final facesFuture = widget.client.assetFaces(widget.asset.id);
      final personsFuture = widget.client.listPersons();
      final faces = await facesFuture;
      final persons = await personsFuture;
      String? url = widget.imageUrl;
      if (url == null) {
        final urlMap = await widget.client
            .assetUrls([widget.asset.id], variant: "preview");
        url = urlMap[widget.asset.id];
      }
      if (!mounted) return;
      final wPx = widget.asset.widthPx;
      final hPx = widget.asset.heightPx;
      setState(() {
        _faces = faces;
        _persons = persons;
        _resolvedUrl = url;
        if (wPx != null && hPx != null) {
          _imageDims = Size(wPx.toDouble(), hPx.toDouble());
        }
        _loading = false;
      });
      // Zoom to first face after the first frame renders the container.
      if (faces.isNotEmpty) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _goToFace(0);
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _goToFace(int index) {
    final dims = _imageDims;
    if (_faces.isEmpty || dims == null || _containerSize == Size.zero) return;
    setState(() => _activeFaceIndex = index);
    final b = _faces[index].bbox;
    final cs = _containerSize;
    final s = min(cs.width / dims.width, cs.height / dims.height);
    final rx = (cs.width - dims.width * s) / 2;
    final ry = (cs.height - dims.height * s) / 2;
    // Face center in container coords (before any zoom)
    final fcx = rx + b.cx * dims.width * s;
    final fcy = ry + b.cy * dims.height * s;
    // Circle diameter as rendered by _FaceImageOverlay (max side + 12px pad)
    final faceDiam = max(b.w * dims.width, b.h * dims.height) * s + 12;
    // Zoom to make the face occupy ~45% of screen width; clamp 2–6×
    final zoom = (cs.width * 0.45 / faceDiam).clamp(2.0, 6.0);
    final tx = cs.width / 2 - zoom * fcx;
    final ty = cs.height / 2 - zoom * fcy;
    _transformController.value = Matrix4.identity()
      ..translateByDouble(tx, ty, 0, 1)
      ..scaleByDouble(zoom, zoom, 1, 1);
  }

  void _prevFace() {
    if (_faces.isEmpty) return;
    _goToFace((_activeFaceIndex - 1 + _faces.length) % _faces.length);
  }

  void _nextFace() {
    if (_faces.isEmpty) return;
    _goToFace((_activeFaceIndex + 1) % _faces.length);
  }

  void _onFaceTapped(AssetFace face) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _FaceTaggingSheet(
        face: face,
        persons: _persons,
        client: widget.client,
        onUpdated: (updated) {
          setState(() {
            final idx = _faces.indexWhere((f) => f.id == updated.id);
            if (idx >= 0) _faces[idx] = updated;
            // When an anonymous cluster was merged into a named person, the
            // old cluster ID is now gone. Propagate the new person to every
            // other face on this image that still carries the stale cluster
            // ID so subsequent tags don't try to merge a deleted cluster.
            final oldPersonId = face.personId;
            if (oldPersonId != null &&
                face.personName == null &&
                updated.personId != null &&
                updated.personId != oldPersonId) {
              for (var i = 0; i < _faces.length; i++) {
                if (_faces[i].personId == oldPersonId &&
                    _faces[i].id != updated.id) {
                  _faces[i] = AssetFace(
                    id: _faces[i].id,
                    bbox: _faces[i].bbox,
                    confidence: _faces[i].confidence,
                    personId: updated.personId,
                    personName: updated.personName,
                  );
                }
              }
            }
          });
        },
        onPersonCreated: (p) {
          setState(() {
            final idx = _persons.indexWhere((x) => x.id == p.id);
            if (idx >= 0) {
              _persons[idx] = p;
            } else {
              _persons = [p, ..._persons];
            }
          });
          widget.onPersonUpdated?.call(p);
        },
      ),
    );
  }

  /// Ignore every face on this photo (PATCH /assets/:id/faces-ignored).
  /// Restorable from People → Ignored. Pops back to the viewer afterwards.
  Future<void> _ignoreAllFaces() async {
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    try {
      await widget.client.setAssetFacesIgnored(widget.asset.id, true);
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(
          content: Text("Faces ignored — restore from People → Ignored"),
        ),
      );
      nav.pop();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text("Couldn't ignore faces: $e")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text("Tag people"),
        actions: [
          if (!_loading && _faces.any((f) => !f.hidden))
            PopupMenuButton<String>(
              tooltip: "Photo actions",
              onSelected: (v) {
                if (v == "ignore_all") _ignoreAllFaces();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: "ignore_all",
                  child: ListTile(
                    leading: Icon(Icons.visibility_off_outlined),
                    title: Text("Ignore all faces"),
                  ),
                ),
              ],
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.error_outline, size: 40, color: Colors.white54),
                        const SizedBox(height: 12),
                        Text(_error!, style: const TextStyle(color: Colors.white70)),
                        const SizedBox(height: 16),
                        FilledButton(onPressed: _load, child: const Text("Retry")),
                      ],
                    ),
                  ),
                )
              : _resolvedUrl == null
                  ? const Center(
                      child: Text(
                        "Image not available",
                        style: TextStyle(color: Colors.white54),
                      ),
                    )
                  : Column(
                      children: [
                        Expanded(
                          child: LayoutBuilder(
                            builder: (ctx, constraints) {
                              final sz = constraints.biggest;
                              // Capture container size for zoom math.
                              if (_containerSize != sz) {
                                _containerSize = sz;
                              }
                              return InteractiveViewer(
                                transformationController: _transformController,
                                minScale: 0.5,
                                maxScale: 8.0,
                                child: _FaceImageOverlay(
                                  imageUrl: _resolvedUrl!,
                                  cacheKey: widget.asset.id,
                                  faces: _faces,
                                  imageDims: _imageDims,
                                  activeId: _faces.isNotEmpty
                                      ? _faces[_activeFaceIndex].id
                                      : null,
                                  onDimsResolved: (size) {
                                    if (_imageDims == null) {
                                      setState(() => _imageDims = size);
                                      WidgetsBinding.instance.addPostFrameCallback((_) {
                                        if (mounted && _faces.isNotEmpty) {
                                          _goToFace(0);
                                        }
                                      });
                                    }
                                  },
                                  onFaceTapped: (face) {
                                    // Snap zoom to tapped face first, then open sheet.
                                    final idx = _faces.indexWhere((f) => f.id == face.id);
                                    if (idx >= 0 && idx != _activeFaceIndex) {
                                      _goToFace(idx);
                                    }
                                    _onFaceTapped(face);
                                  },
                                  showNames: _showNames,
                                  onImageTapped: () =>
                                      setState(() => _showNames = !_showNames),
                                ),
                              );
                            },
                          ),
                        ),
                        // Face navigation bar — only shown when multiple faces detected.
                        if (_faces.length > 1)
                          Container(
                            color: Colors.black,
                            padding: const EdgeInsets.symmetric(
                                horizontal: 24, vertical: 10),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                IconButton(
                                  icon: const Icon(Icons.chevron_left,
                                      color: Colors.white, size: 32),
                                  onPressed: _prevFace,
                                  tooltip: "Previous face",
                                ),
                                GestureDetector(
                                  onTap: () => _onFaceTapped(_faces[_activeFaceIndex]),
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(
                                        "${_activeFaceIndex + 1} / ${_faces.length}",
                                        style: const TextStyle(
                                            color: Colors.white,
                                            fontSize: 16,
                                            fontWeight: FontWeight.w600),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        _faces[_activeFaceIndex].personName ??
                                            "Tap to tag",
                                        style: Theme.of(context).textTheme.labelMedium?.copyWith(
                                              color: _faces[_activeFaceIndex].personName != null
                                                  ? Theme.of(context).colorScheme.primary
                                                  : Colors.white54,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.chevron_right,
                                      color: Colors.white, size: 32),
                                  onPressed: _nextFace,
                                  tooltip: "Next face",
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
    );
  }
}

class _FaceImageOverlay extends StatelessWidget {
  const _FaceImageOverlay({
    required this.imageUrl,
    required this.faces,
    required this.imageDims,
    required this.onDimsResolved,
    required this.onFaceTapped,
    required this.showNames,
    required this.onImageTapped,
    this.activeId,
    this.cacheKey,
  });

  final String imageUrl;
  final List<AssetFace> faces;
  final Size? imageDims;
  final void Function(Size) onDimsResolved;
  final void Function(AssetFace) onFaceTapped;
  final bool showNames;
  final VoidCallback onImageTapped;
  // When set, this face circle renders larger + brighter (active in nav mode).
  final String? activeId;
  // Stable per-asset disk-cache key so the full-res preview resolves offline
  // after its signed URL expires (served from OfflineCache.previews).
  final String? cacheKey;

  @override
  Widget build(BuildContext context) {
    final primary = Theme.of(context).colorScheme.primary;
    return LayoutBuilder(builder: (ctx, constraints) {
      final ww = constraints.maxWidth;
      final wh = constraints.maxHeight;
      return Stack(
        fit: StackFit.expand,
        children: [
          GestureDetector(
            onTap: onImageTapped,
            child: const SizedBox.expand(),
          ),
          CachedNetworkImage(
            imageUrl: imageUrl,
            cacheManager: OfflineCache.previews,
            cacheKey: cacheKey,
            fit: BoxFit.contain,
            imageBuilder: (ctx, imageProvider) {
              imageProvider.resolve(ImageConfiguration.empty).addListener(
                ImageStreamListener((info, _) {
                  onDimsResolved(Size(
                    info.image.width.toDouble(),
                    info.image.height.toDouble(),
                  ));
                }),
              );
              return Image(image: imageProvider, fit: BoxFit.contain);
            },
            placeholder: (_, __) =>
                const Center(child: CircularProgressIndicator()),
            errorWidget: (_, __, ___) =>
                const Icon(Icons.broken_image, color: Colors.white54, size: 48),
          ),
          if (imageDims != null)
            ..._buildFaceOverlays(ww, wh, imageDims!, primary),
        ],
      );
    });
  }

  List<Widget> _buildFaceOverlays(double ww, double wh, Size dims, Color taggedColor) {
    final s = min(ww / dims.width, wh / dims.height);
    final rx = (ww - dims.width * s) / 2;
    final ry = (wh - dims.height * s) / 2;
    return _dedupeByBbox(faces).expand<Widget>((face) {
      final b = face.bbox;
      final left = rx + b.x * dims.width * s;
      final top = ry + b.y * dims.height * s;
      final fw = b.w * dims.width * s;
      final fh = b.h * dims.height * s;
      final isActive = activeId != null && face.id == activeId;
      final d = max(fw, fh) + (isActive ? 20 : 12);
      final cx = left + fw / 2;
      final cy = top + fh / 2;
      // Active face stays yellow — high-contrast against any photo content.
      // TODO: tokenise once a face-tag palette exists.
      final borderColor = isActive
          ? Colors.yellowAccent
          : face.personId != null
              ? taggedColor
              : Colors.white70;
      final borderWidth = isActive ? 1.5 : 1.0;
      final circle = Positioned(
        left: cx - d / 2,
        top: cy - d / 2,
        width: d,
        height: d,
        child: GestureDetector(
          onTap: () => onFaceTapped(face),
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: borderColor, width: borderWidth),
            ),
          ),
        ),
      );
      if (!showNames || face.personName == null) return [circle];
      final label = Positioned(
        left: cx - 60,
        top: cy + d / 2 + 2,
        width: 120,
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 1),
            decoration: BoxDecoration(
              color: Colors.black54,
              borderRadius: BorderRadius.circular(3),
            ),
            child: Text(
              face.personName!,
              style: const TextStyle(color: Colors.white, fontSize: 9),
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
            ),
          ),
        ),
      );
      return [circle, label];
    }).toList();
  }

  /// Fold faces whose bbox centers fall within a small radius into one survivor.
  /// Server-side detection has historically been re-run without dedupe, so the
  /// same physical face can come back as multiple AssetFace rows — when that
  /// happens we'd otherwise paint concentric circles in slightly different
  /// shades (active yellow stacked on tagged primary). Preference order:
  /// named > anonymous; higher confidence wins ties.
  static List<AssetFace> _dedupeByBbox(List<AssetFace> input) {
    if (input.length < 2) return input;
    const tol = 0.02; // ≈2% of image dimension — tight enough to keep distinct faces.
    final kept = <AssetFace>[];
    for (final f in input) {
      final cx = f.bbox.x + f.bbox.w / 2;
      final cy = f.bbox.y + f.bbox.h / 2;
      final dupIdx = kept.indexWhere((k) {
        final kcx = k.bbox.x + k.bbox.w / 2;
        final kcy = k.bbox.y + k.bbox.h / 2;
        return (kcx - cx).abs() < tol && (kcy - cy).abs() < tol;
      });
      if (dupIdx < 0) {
        kept.add(f);
        continue;
      }
      final existing = kept[dupIdx];
      final fScore = (f.personId != null ? 1000 : 0) + f.confidence;
      final eScore = (existing.personId != null ? 1000 : 0) + existing.confidence;
      if (fScore > eScore) kept[dupIdx] = f;
    }
    return kept;
  }
}

class _FaceTaggingSheet extends StatefulWidget {
  const _FaceTaggingSheet({
    required this.face,
    required this.persons,
    required this.client,
    required this.onUpdated,
    required this.onPersonCreated,
  });

  final AssetFace face;
  final List<Person> persons;
  final FontoClient client;
  final void Function(AssetFace) onUpdated;
  final void Function(Person) onPersonCreated;

  @override
  State<_FaceTaggingSheet> createState() => _FaceTaggingSheetState();
}

class _FaceTaggingSheetState extends State<_FaceTaggingSheet> {
  final _ctrl = TextEditingController();
  bool _saving = false;
  String? _saveError;
  List<FaceSuggestion> _suggestions = const [];
  bool _suggestionsLoading = false;

  @override
  void initState() {
    super.initState();
    _loadSuggestions();
  }

  Future<void> _loadSuggestions() async {
    setState(() => _suggestionsLoading = true);
    try {
      final s = await widget.client.faceSuggestions(widget.face.id);
      if (mounted) setState(() { _suggestions = s; _suggestionsLoading = false; });
    } catch (_) {
      if (mounted) setState(() => _suggestionsLoading = false);
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  List<Person> get _filtered {
    final q = _ctrl.text.toLowerCase().trim();
    if (q.isEmpty) return widget.persons;
    return widget.persons
        .where((p) => (p.name ?? "").toLowerCase().contains(q))
        .toList();
  }

  Future<void> _assignTo(Person person) async {
    // Capture before any await so we don't pass a stale context across
    // the async gap (Flutter analyzer complains, and worse: the messenger
    // would null out if the sheet popped before the error fired).
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      final oldPersonId = widget.face.personId;
      // Anonymous cluster = has a cluster but no name. Guard against self-merge
      // (user tapping the same cluster they're already in would send
      // mergePerson(X, X) → 400 from the server).
      final isAnonymousCluster = oldPersonId != null &&
          widget.face.personName == null &&
          oldPersonId != person.id;
      if (isAnonymousCluster) {
        // Merge the whole anonymous cluster into the named person — this
        // reassigns every face in the cluster at once and deletes the anon record.
        await widget.client.mergePerson(oldPersonId, person.id);
      } else {
        await widget.client.assignFace(widget.face.id, person.id);
      }
      if (!mounted) return;
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
        personId: person.id,
        personName: person.name,
      ));
      nav.pop();
    } catch (e) {
      // SnackBar over inline text — inline could sit hidden behind the
      // soft keyboard; a SnackBar is always rendered above everything.
      messenger.showSnackBar(
        SnackBar(content: Text("Couldn't assign to ${person.name ?? 'person'}: $e")),
      );
      if (mounted) setState(() => _saveError = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _createAndAssign() async {
    final name = _ctrl.text.trim();
    if (name.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      final Person person;
      if (widget.face.personId != null) {
        // Face already belongs to a cluster — rename the whole cluster so every
        // photo in the group picks up the name without re-assigning faces.
        person = await widget.client.updatePersonName(widget.face.personId!, name);
        if (!mounted) return;
        widget.onPersonCreated(person);
      } else {
        person = await widget.client.createPerson(name: name);
        if (!mounted) return;
        widget.onPersonCreated(person);
        await widget.client.assignFace(widget.face.id, person.id);
        if (!mounted) return;
      }
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
        personId: person.id,
        personName: person.name,
      ));
      nav.pop();
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text("Couldn't save \"$name\": $e")),
      );
      if (mounted) setState(() => _saveError = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _clearAssignment() async {
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() { _saving = true; _saveError = null; });
    try {
      await widget.client.assignFace(widget.face.id, null);
      if (!mounted) return;
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
      ));
      nav.pop();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't clear assignment: $e")));
      if (mounted) setState(() => _saveError = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Ignore (hide) just this one face. PATCH /faces/:id { hidden:true }.
  /// Restorable from People → Ignored. Marks the face hidden locally so it
  /// drops out of the on-photo overlay, then closes the sheet.
  Future<void> _ignoreFace() async {
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() { _saving = true; _saveError = null; });
    try {
      await widget.client.setFaceHidden(widget.face.id, true);
      if (!mounted) return;
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
        personId: widget.face.personId,
        personName: widget.face.personName,
        hidden: true,
      ));
      nav.pop();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't ignore face: $e")));
      if (mounted) setState(() => _saveError = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Phase 3 (faces/UX) — clear the NAME of the cluster this face belongs to
  /// (keeps the face assigned to the cluster). Sends `null`, which the PATCH
  /// route treats as "unname". This is the in-flow fix for the reported
  /// name-removal bug; distinct from "Remove assignment" which detaches a face.
  Future<void> _removeClusterName() async {
    final personId = widget.face.personId;
    if (personId == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() { _saving = true; _saveError = null; });
    try {
      final person = await widget.client.updatePersonName(personId, null);
      if (!mounted) return;
      widget.onPersonCreated(person);
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
        personId: personId,
        personName: person.name,
      ));
      nav.pop();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't remove name: $e")));
      if (mounted) setState(() => _saveError = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filtered;
    final query = _ctrl.text.trim();
    final exactMatch = widget.persons.any(
      (p) => (p.name ?? "").toLowerCase() == query.toLowerCase(),
    );

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.65,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 8),
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.outlineVariant,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Text(
                  widget.face.personName != null
                      ? "Reassign: ${widget.face.personName}"
                      : "Who is this?",
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  controller: _ctrl,
                  autofocus: true,
                  decoration: const InputDecoration(
                    hintText: "Search or type a name…",
                    prefixIcon: Icon(Icons.search),
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              if (_saveError != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  child: Text(
                    _saveError!,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.error,
                        ),
                  ),
                ),
              if (_suggestionsLoading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
                )
              else if (_suggestions.isNotEmpty && _ctrl.text.trim().isEmpty)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                      child: Text(
                        "Suggestions",
                        style: Theme.of(context).textTheme.labelMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                              color: Theme.of(context).colorScheme.onSurfaceVariant,
                            ),
                      ),
                    ),
                    ..._suggestions
                        .where((s) => s.person.id != widget.face.personId)
                        .map((s) {
                      final String subtitle;
                      if (s.distance < 0.20) {
                        subtitle = "Best match";
                      } else if (s.distance < 0.28) {
                        subtitle = "Good match";
                      } else {
                        subtitle = "Possible match";
                      }
                      return ListTile(
                        leading: const Icon(Icons.person_outline),
                        title: Text(s.person.name ?? "Unnamed"),
                        subtitle: Text(subtitle),
                        onTap: _saving ? null : () => _assignTo(s.person),
                      );
                    }),
                    const Divider(),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                      child: Text(
                        "All people",
                        style: Theme.of(context).textTheme.labelMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                              color: Theme.of(context).colorScheme.onSurfaceVariant,
                            ),
                      ),
                    ),
                  ],
                ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    if (query.isNotEmpty && !exactMatch)
                      ListTile(
                        leading: const Icon(Icons.person_add_outlined),
                        title: Text('Create "$query"'),
                        onTap: _saving ? null : _createAndAssign,
                      ),
                    // Phase 3 (faces/UX) — clear just the cluster NAME (keeps
                    // the face assigned). Only when the cluster has a name.
                    if (widget.face.personId != null &&
                        widget.face.personName != null)
                      ListTile(
                        leading: const Icon(Icons.label_off_outlined),
                        title: const Text("Remove name"),
                        onTap: _saving ? null : _removeClusterName,
                      ),
                    if (widget.face.personId != null)
                      ListTile(
                        leading: const Icon(Icons.person_remove_outlined),
                        title: const Text("Remove assignment"),
                        onTap: _saving ? null : _clearAssignment,
                      ),
                    ListTile(
                      leading: const Icon(Icons.visibility_off_outlined),
                      title: const Text("Ignore this face"),
                      onTap: _saving ? null : _ignoreFace,
                    ),
                    ...filtered.map(
                      (p) => ListTile(
                        leading: const Icon(Icons.person_outline),
                        title: Text(p.name ?? "Unnamed"),
                        subtitle: Text("${p.instanceCount} photos"),
                        onTap: _saving ? null : () => _assignTo(p),
                      ),
                    ),
                  ],
                ),
              ),
              if (_saving)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Task #34 — in-app cropper. crop_your_image renders the source bytes + a
// draggable rect overlay; we expose the image-space rect via the controller
// and pop it back to the caller, which converts to normalised coords + POSTs
// to /transform.
// ---------------------------------------------------------------------------

class _CropScreen extends StatefulWidget {
  const _CropScreen({required this.bytes});

  final Uint8List bytes;

  @override
  State<_CropScreen> createState() => _CropScreenState();
}

class _CropScreenState extends State<_CropScreen> {
  final CropController _controller = CropController();
  // Image-space rect of the current crop area, tracked via `onMoved`. The
  // CropController doesn't expose a getter for this, so we cache the latest
  // value here and pop it on Save. Seeded with the full-image rect on first
  // build so the user can hit Save immediately if they want everything (the
  // server will be a no-op crop in that case).
  Rect? _imageRect;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _decodeImageSize();
  }

  Future<void> _decodeImageSize() async {
    try {
      final codec = await ui.instantiateImageCodec(widget.bytes);
      final frame = await codec.getNextFrame();
      final img = frame.image;
      if (!mounted) {
        img.dispose();
        return;
      }
      final size = Size(img.width.toDouble(), img.height.toDouble());
      img.dispose();
      setState(() {
        // Seed the rect so Save is enabled even before the user touches the
        // overlay — defaults to the full image (~no-op crop).
        _imageRect = Rect.fromLTWH(0, 0, size.width, size.height);
      });
    } catch (_) {
      /* Cropper still renders, but Save stays disabled until the user moves
         the handles + onMoved fires. */
    }
  }

  void _onConfirm() {
    if (_busy) return;
    setState(() => _busy = true);
    Navigator.of(context).pop<Rect?>(_imageRect);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text("Crop"),
        actions: [
          TextButton(
            onPressed: (_busy || _imageRect == null) ? null : _onConfirm,
            child: Text(
              "Save",
              style: TextStyle(
                color: (_busy || _imageRect == null)
                    ? Colors.white38
                    : cs.primary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Crop(
          controller: _controller,
          image: widget.bytes,
          baseColor: Colors.black,
          maskColor: Colors.black54,
          // No fixed aspect — operator picks freely. cornerDotBuilder gives a
          // visible drag affordance on a dark photo background.
          cornerDotBuilder: (size, edge) => DotControl(color: cs.primary),
          onMoved: (_, imageRect) {
            // Stash the source-pixel rect; the controller doesn't expose a
            // getter, so this is the only read path.
            _imageRect = imageRect;
          },
          onCropped: (_) {
            // We don't use the cropped bytes — the server re-extracts from the
            // original at the rect we send. crop() is never called.
          },
        ),
      ),
    );
  }
}

/// "More like this" — horizontal strip of CLIP visual neighbours shown in the
/// asset info sheet. Loads similar assets + their thumbnails lazily; renders
/// nothing while empty so the sheet stays compact for non-matching assets.
class _SimilarStrip extends StatefulWidget {
  const _SimilarStrip({
    required this.client,
    required this.assetId,
    required this.onTap,
  });

  final FontoClient client;
  final String assetId;
  final void Function(Asset) onTap;

  @override
  State<_SimilarStrip> createState() => _SimilarStripState();
}

class _SimilarStripState extends State<_SimilarStrip> {
  bool _loading = true;
  List<Asset> _assets = const [];
  Map<String, String> _thumbs = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final neighbours = await widget.client.similarAssets(widget.assetId);
      Map<String, String> thumbs = const {};
      if (neighbours.isNotEmpty) {
        thumbs = await widget.client
            .assetUrls(neighbours.map((a) => a.id).toList(), variant: "thumb");
      }
      if (!mounted) return;
      setState(() {
        _assets = neighbours;
        _thumbs = thumbs;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.only(top: 16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_assets.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 16),
        Text(
          "More like this",
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.outline,
              ),
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: 72,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: _assets.length,
            separatorBuilder: (_, __) => const SizedBox(width: 8),
            itemBuilder: (_, i) {
              final a = _assets[i];
              final url = _thumbs[a.id];
              return GestureDetector(
                onTap: () => widget.onTap(a),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: SizedBox(
                    width: 72,
                    height: 72,
                    child: url == null
                        ? Container(color: Theme.of(context).colorScheme.surfaceContainerHighest)
                        : CachedNetworkImage(
                            imageUrl: url,
                            fit: BoxFit.cover,
                            memCacheWidth: 200,
                            placeholder: (_, __) => Container(
                              color: Theme.of(context).colorScheme.surfaceContainerHighest,
                            ),
                            errorWidget: (_, __, ___) => Container(
                              color: Theme.of(context).colorScheme.surfaceContainerHighest,
                            ),
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
