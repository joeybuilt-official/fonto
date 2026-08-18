// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Full-screen viewer for one local camera-roll asset from the "On this
// device" strip. Purely local — resolves the original file via photo_manager,
// no network. Images pinch-zoom via InteractiveViewer; videos play from the
// local file (tap toggles play/pause); anything else shows filename + size +
// created date. The strip's cloud-arrow-up badge carries over as a chip so
// the user knows this copy is still waiting to upload to Fonto.

import "dart:io";

import "package:flutter/material.dart";
import "package:photo_manager/photo_manager.dart";
import "package:video_player/video_player.dart";

class DeviceAssetViewerScreen extends StatefulWidget {
  const DeviceAssetViewerScreen({super.key, required this.entity});

  final AssetEntity entity;

  @override
  State<DeviceAssetViewerScreen> createState() =>
      _DeviceAssetViewerScreenState();
}

class _DeviceAssetViewerScreenState extends State<DeviceAssetViewerScreen> {
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

  Widget _content() {
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
      return InteractiveViewer(
        minScale: 0.5,
        maxScale: 8.0,
        child: Center(
          child: Image.file(_file!, fit: BoxFit.contain),
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

  @override
  Widget build(BuildContext context) {
    // Viewer chrome stays black/white like AssetDetailScreen — media reads
    // best on a dark surround regardless of system theme.
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
          _content(),
          Positioned(
            left: 0,
            right: 0,
            bottom: 16,
            child: SafeArea(
              top: false,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
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
              ),
            ),
          ),
        ],
      ),
    );
  }
}
