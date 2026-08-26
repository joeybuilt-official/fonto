// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Full-screen viewer for the "On this device" camera-roll strip. Takes the
// list of local entities the strip is showing plus the tapped index, so the
// user can swipe left/right between them (PageView) and jump around via a
// centered bottom thumbnail-nav strip — matching the server AssetDetailScreen.
// Purely local — every page resolves its original file via photo_manager, no
// network. Images pinch-zoom via PhotoView (which cooperates with the PageView
// so a horizontal drag at fit-scale pages instead of being swallowed); videos
// play from the local file (tap toggles play/pause); anything else shows
// filename + size + created date. The strip's cloud-arrow-up badge carries over
// as a chip so the user knows these copies are still waiting to upload to Fonto.

import "dart:io";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:photo_manager/photo_manager.dart";
import "package:photo_view/photo_view.dart";
import "package:video_player/video_player.dart";

class DeviceAssetViewerScreen extends StatefulWidget {
  const DeviceAssetViewerScreen({
    super.key,
    required this.entities,
    required this.initialIndex,
  });

  final List<AssetEntity> entities;
  final int initialIndex;

  @override
  State<DeviceAssetViewerScreen> createState() =>
      _DeviceAssetViewerScreenState();
}

class _DeviceAssetViewerScreenState extends State<DeviceAssetViewerScreen> {
  late final PageController _page =
      PageController(initialPage: widget.initialIndex);
  late int _index = widget.initialIndex;
  // Bottom thumbnail-nav strip — its own scroll controller so the strip can
  // keep the current asset centered as the user swipes the main PageView.
  final ScrollController _stripScroll = ScrollController();
  static const double _stripItemExtent = 64;
  // App-bar title for the current page; resolved lazily off the device.
  String _title = "";

  @override
  void initState() {
    super.initState();
    _resolveTitle(_index);
    WidgetsBinding.instance.addPostFrameCallback((_) => _centerStrip(_index));
  }

  @override
  void dispose() {
    _page.dispose();
    _stripScroll.dispose();
    super.dispose();
  }

  void _onPageChanged(int i) {
    setState(() => _index = i);
    _resolveTitle(i);
    _centerStrip(i);
  }

  /// Resolve the app-bar title for page [i]. Applied only if the user is still
  /// on that page when the async title returns (guards a fast swipe from
  /// stamping a stale title).
  Future<void> _resolveTitle(int i) async {
    final title = await widget.entities[i].titleAsync;
    if (!mounted || _index != i) return;
    setState(() => _title = title);
  }

  /// Scrolls the thumbnail strip so item [i] stays centered in its viewport.
  /// Honors reduced-motion — jumps instead of animating when the platform
  /// disables implicit animations.
  void _centerStrip(int i) {
    if (!_stripScroll.hasClients) return;
    final target = ((i * _stripItemExtent) -
            (_stripScroll.position.viewportDimension / 2) +
            (_stripItemExtent / 2))
        .clamp(0.0, _stripScroll.position.maxScrollExtent);
    if (MediaQuery.of(context).disableAnimations) {
      _stripScroll.jumpTo(target);
      return;
    }
    _stripScroll.animateTo(
      target,
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
    );
  }

  /// Tap-to-jump from a strip thumbnail. Honors reduced-motion.
  void _jumpToPage(int i) {
    if (MediaQuery.of(context).disableAnimations) {
      _page.jumpToPage(i);
      return;
    }
    _page.animateToPage(
      i,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
  }

  @override
  Widget build(BuildContext context) {
    // Viewer chrome stays black/white like AssetDetailScreen — media reads
    // best on a dark surround regardless of system theme.
    final entities = widget.entities;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          _title,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                color: Colors.white,
              ),
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          PageView.builder(
            controller: _page,
            itemCount: entities.length,
            onPageChanged: _onPageChanged,
            itemBuilder: (context, i) => _DevicePage(
              key: ValueKey(entities[i].id),
              entity: entities[i],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _uploadFooter(),
                  const SizedBox(height: 10),
                  // A one-item strip is just the tile you tapped — skip it.
                  if (entities.length > 1) _thumbnailStrip(entities),
                ],
              ),
            ),
          ),
          // Location pill — makes it obvious at a glance that this copy lives
          // only on the phone (not yet on Fonto). Server assets have no pill;
          // absence reads as "on Fonto".
          const Positioned(
            top: 8,
            left: 0,
            right: 0,
            child: Center(child: _LocationPill()),
          ),
        ],
      ),
    );
  }

  Widget _uploadFooter() {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: Colors.black54,
          borderRadius: BorderRadius.circular(16),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.cloud_upload_outlined,
              size: 14,
              color: Colors.white,
            ),
            SizedBox(width: 6),
            Text(
              "Waiting to upload to Fonto",
              style: TextStyle(color: Colors.white, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }

  /// Bottom thumbnail-nav strip: a scrollable row of on-device thumbnails,
  /// current one highlighted, tap-to-jump via [_page]. Kept centered on
  /// [_index] by [_centerStrip]. Thumbnails decode at a small square size via
  /// [_DeviceStripThumb] — never the full-res original the main page shows.
  Widget _thumbnailStrip(List<AssetEntity> entities) {
    final reducedMotion = MediaQuery.of(context).disableAnimations;
    return Container(
      height: 72,
      color: Colors.black54,
      child: ListView.builder(
        controller: _stripScroll,
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: entities.length,
        itemExtent: _stripItemExtent,
        itemBuilder: (context, i) {
          final current = i == _index;
          return Center(
            child: GestureDetector(
              onTap: () => _jumpToPage(i),
              child: AnimatedContainer(
                duration: reducedMotion
                    ? Duration.zero
                    : const Duration(milliseconds: 150),
                width: current ? 56 : 44,
                height: current ? 56 : 44,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(8),
                  border: current
                      ? Border.all(color: Colors.white, width: 2)
                      : null,
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: _DeviceStripThumb(
                    key: ValueKey(entities[i].id),
                    entity: entities[i],
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// One page of the device viewer: resolves its own original file off the device
/// and renders per entity type. Owns any [VideoPlayerController] for its page so
/// the controller is created when the page builds and disposed when the user
/// swipes away — bounding live controllers/decodes to the pages the PageView
/// keeps around.
class _DevicePage extends StatefulWidget {
  const _DevicePage({super.key, required this.entity});

  final AssetEntity entity;

  @override
  State<_DevicePage> createState() => _DevicePageState();
}

class _DevicePageState extends State<_DevicePage> {
  String _title = "";
  File? _file;
  int? _bytes;
  bool _loading = true;
  bool _failed = false;
  VideoPlayerController? _video;
  bool _disposed = false;

  bool get _isImage => widget.entity.type == AssetType.image;
  bool get _isVideo => widget.entity.type == AssetType.video;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final title = await widget.entity.titleAsync;
    final file = await widget.entity.file;
    if (_disposed) return;
    if (file == null) {
      setState(() {
        _title = title;
        _loading = false;
        _failed = true;
      });
      return;
    }
    if (_isVideo) {
      final controller = VideoPlayerController.file(file);
      try {
        await controller.initialize();
      } catch (_) {
        await controller.dispose();
        if (_disposed) return;
        setState(() {
          _title = title;
          _loading = false;
          _failed = true;
        });
        return;
      }
      if (_disposed) {
        await controller.dispose();
        return;
      }
      await controller.setLooping(false);
      if (_disposed) {
        await controller.dispose();
        return;
      }
      setState(() {
        _title = title;
        _file = file;
        _video = controller;
        _loading = false;
      });
      return;
    }
    int? bytes;
    if (!_isImage) {
      bytes = await file.length();
      if (_disposed) return;
    }
    setState(() {
      _title = title;
      _file = file;
      _bytes = bytes;
      _loading = false;
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _video?.dispose();
    super.dispose();
  }

  void _togglePlay() {
    final c = _video;
    if (c == null) return;
    setState(() {
      if (c.value.isPlaying) {
        c.pause();
      } else {
        c.play();
      }
    });
  }

  String _fmtDate(DateTime d) {
    const m = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    return "${m[d.month - 1]} ${d.day}, ${d.year}";
  }

  String _fmtSize(int b) {
    if (b < 1024) return "$b B";
    if (b < 1024 * 1024) return "${(b / 1024).round()} KB";
    return "${(b / (1024 * 1024)).toStringAsFixed(1)} MB";
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_failed) {
      return const Center(
        child: Text(
          "Could not load this item.",
          style: TextStyle(color: Colors.white70),
        ),
      );
    }
    if (_isImage) {
      // PhotoView (not InteractiveViewer) so a horizontal drag at fit-scale
      // pages the parent PageView instead of being swallowed by pan; once
      // zoomed in, PhotoView owns the drag for panning. The horizontal
      // gesture-detector scope is what hands fit-scale swipes back to the
      // PageView — the same wiring PhotoViewGallery does internally.
      return PhotoViewGestureDetectorScope(
        axis: Axis.horizontal,
        child: PhotoView(
          imageProvider: FileImage(_file!),
          minScale: PhotoViewComputedScale.contained,
          maxScale: PhotoViewComputedScale.covered * 4.0,
          initialScale: PhotoViewComputedScale.contained,
          backgroundDecoration: const BoxDecoration(color: Colors.black),
        ),
      );
    }
    if (_isVideo) return _videoContent();
    return _detailsContent();
  }

  Widget _videoContent() {
    final c = _video!;
    return GestureDetector(
      onTap: _togglePlay,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Center(
            child: AspectRatio(
              aspectRatio:
                  c.value.aspectRatio == 0 ? 16 / 9 : c.value.aspectRatio,
              child: VideoPlayer(c),
            ),
          ),
          if (!c.value.isPlaying)
            Container(
              decoration: const BoxDecoration(
                color: Colors.black54,
                shape: BoxShape.circle,
              ),
              padding: const EdgeInsets.all(12),
              child: const Icon(
                Icons.play_arrow,
                color: Colors.white,
                size: 44,
              ),
            ),
        ],
      ),
    );
  }

  Widget _detailsContent() {
    final detail = Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: Colors.white70,
        );
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.insert_drive_file_outlined,
              size: 44,
              color: Colors.white54,
            ),
            const SizedBox(height: 12),
            Text(
              _title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    color: Colors.white,
                  ),
            ),
            const SizedBox(height: 8),
            if (_bytes != null) Text(_fmtSize(_bytes!), style: detail),
            Text(_fmtDate(widget.entity.createDateTime), style: detail),
          ],
        ),
      ),
    );
  }
}

/// Small "On device" chip shown at the top of the viewer so the user can tell
/// at a glance the photo lives only on the phone (still pending upload to
/// Fonto). Uses the same smartphone icon as the home "On this device" section.
class _LocationPill extends StatelessWidget {
  const _LocationPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.black54,
        borderRadius: BorderRadius.circular(16),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.smartphone_outlined, size: 13, color: Colors.white),
          SizedBox(width: 5),
          Text(
            "On device",
            style: TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

/// A single thumbnail in the bottom nav strip. Resolves a small square thumb
/// straight from the device (never the full-res original) and holds the future
/// so parent rebuilds don't kick a fresh decode and flash the tile. Mirrors the
/// home-screen `_DeviceTile` decode pattern at a smaller size.
class _DeviceStripThumb extends StatefulWidget {
  const _DeviceStripThumb({super.key, required this.entity});

  final AssetEntity entity;

  @override
  State<_DeviceStripThumb> createState() => _DeviceStripThumbState();
}

class _DeviceStripThumbState extends State<_DeviceStripThumb> {
  late Future<Uint8List?> _thumb;

  @override
  void initState() {
    super.initState();
    _thumb = _resolve();
  }

  @override
  void didUpdateWidget(covariant _DeviceStripThumb oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.entity.id != widget.entity.id) _thumb = _resolve();
  }

  Future<Uint8List?> _resolve() =>
      widget.entity.thumbnailDataWithSize(const ThumbnailSize.square(150));

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List?>(
      future: _thumb,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return Container(color: Colors.white24);
        }
        final data = snapshot.data;
        if (data == null) {
          return Container(
            color: Colors.white24,
            child: const Icon(
              Icons.broken_image,
              color: Colors.white54,
              size: 20,
            ),
          );
        }
        return Image.memory(data, fit: BoxFit.cover);
      },
    );
  }
}
