// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// In-app HLS video playback. Fetches the on-demand manifest from
// /api/v1/assets/:id/hls (polling while the server transcodes), then plays
// the master playlist through video_player. The playlist + its .ts segments
// are served by an auth-gated proxy, so the PAT rides along on every fetch
// via httpHeaders. Minimal controls: tap to play/pause + a scrub bar.

import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:video_player/video_player.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";

class AssetVideoPlayer extends StatefulWidget {
  const AssetVideoPlayer({
    super.key,
    required this.client,
    required this.asset,
  });

  final FontoClient client;
  final Asset asset;

  @override
  State<AssetVideoPlayer> createState() => _AssetVideoPlayerState();
}

class _AssetVideoPlayerState extends State<AssetVideoPlayer> {
  VideoPlayerController? _controller;
  Timer? _poll;
  // Bounds the transcode wait so "Preparing video…" can't spin forever if the
  // server never flips ready/failed. ~40 polls × 3s ≈ 2 min.
  int _pollAttempts = 0;
  static const int _maxPollAttempts = 40;
  bool _disposed = false;
  // null = still resolving; non-null = terminal error to show.
  String? _error;
  bool _transcoding = false;
  bool _showControls = true;
  // Auto-hides the overlay controls a few seconds into playback.
  Timer? _hideTimer;
  // Tracks the last observed play state so we re-arm the auto-hide only on a
  // paused→playing edge, not on every position tick the listener fires.
  bool _lastPlaying = false;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  Future<void> _resolve() async {
    try {
      final m = await widget.client.assetHls(widget.asset.id);
      if (_disposed) return;
      if (m.isReady) {
        await _startPlayback(m.playlistUrl!);
      } else if (m.isFailed) {
        setState(() => _error = "Transcode failed for this video.");
      } else {
        // transcoding / idle — poll until ready.
        setState(() => _transcoding = true);
        _poll = Timer.periodic(const Duration(seconds: 3), (_) => _pollOnce());
      }
    } on ApiException catch (e) {
      if (!_disposed) setState(() => _error = e.message);
    } catch (e) {
      if (!_disposed) setState(() => _error = "$e");
    }
  }

  Future<void> _pollOnce() async {
    if (_disposed) return;
    _pollAttempts++;
    if (_pollAttempts >= _maxPollAttempts) {
      _poll?.cancel();
      setState(() {
        _transcoding = false;
        _error = "Still preparing — try again later.";
      });
      return;
    }
    try {
      final m = await widget.client.assetHls(widget.asset.id);
      if (_disposed) return;
      if (m.isReady) {
        _poll?.cancel();
        await _startPlayback(m.playlistUrl!);
      } else if (m.isFailed) {
        _poll?.cancel();
        setState(() {
          _transcoding = false;
          _error = "Transcode failed for this video.";
        });
      }
    } catch (_) {
      // Transient poll error — keep polling; a terminal failure flips state.
    }
  }

  /// Clears the terminal error/transcode state and re-runs resolution. Wired to
  /// the Retry button so a failed load isn't a dead end.
  void _retry() {
    _poll?.cancel();
    setState(() {
      _error = null;
      _transcoding = false;
      _pollAttempts = 0;
    });
    _resolve();
  }

  Future<void> _startPlayback(String playlistUrl) async {
    final auth = widget.client.auth;
    final uri = Uri.parse("${auth.baseUrl}$playlistUrl");
    final controller = VideoPlayerController.networkUrl(
      uri,
      httpHeaders: {"Authorization": "Bearer ${auth.pat ?? ""}"},
    );
    try {
      await controller.initialize();
    } catch (e) {
      if (!_disposed) setState(() => _error = "Could not load video.");
      await controller.dispose();
      return;
    }
    if (_disposed) {
      await controller.dispose();
      return;
    }
    await controller.setLooping(false);
    // Drive the play/pause icon, buffering spinner, and auto-hide off real
    // player state instead of only on explicit taps.
    controller.addListener(_onControllerUpdate);
    // Start paused with the first frame + play button shown, so swiping
    // between pages never bleeds audio from an off-screen video.
    setState(() {
      _controller = controller;
      _transcoding = false;
      _showControls = true;
    });
  }

  void _onControllerUpdate() {
    if (_disposed || !mounted) return;
    final playing = _controller?.value.isPlaying ?? false;
    if (playing != _lastPlaying) {
      _lastPlaying = playing;
      if (playing) {
        _scheduleHideControls();
      } else {
        // Paused or ended — keep the controls up so the play button is reachable.
        _hideTimer?.cancel();
        _showControls = true;
      }
    }
    setState(() {});
  }

  /// Fades the controls out a few seconds into playback (only while playing).
  void _scheduleHideControls() {
    _hideTimer?.cancel();
    final c = _controller;
    if (c == null || !c.value.isPlaying || !_showControls) return;
    _hideTimer = Timer(const Duration(seconds: 3), () {
      if (!_disposed && mounted) setState(() => _showControls = false);
    });
  }

  void _toggleControls() {
    setState(() => _showControls = !_showControls);
    if (_showControls) _scheduleHideControls();
  }

  void _togglePlay() {
    final c = _controller;
    if (c == null) return;
    HapticFeedback.selectionClick();
    setState(() {
      if (c.value.isPlaying) {
        c.pause();
      } else {
        c.play();
      }
      _showControls = true;
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _hideTimer?.cancel();
    _controller?.removeListener(_onControllerUpdate);
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return _centered(
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Colors.white70, size: 44),
            const SizedBox(height: 12),
            Text(
              _error!,
              textAlign: TextAlign.center,
              // Video chrome is always on a black backdrop — text needs to be
              // white regardless of theme.
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Colors.white70,
                  ),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _retry,
              child: const Text("Retry"),
            ),
          ],
        ),
      );
    }

    if (_transcoding) {
      return _centered(
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              "Preparing video…",
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Colors.white70,
                  ),
            ),
          ],
        ),
      );
    }

    final c = _controller;
    if (c == null || !c.value.isInitialized) {
      return _centered(const CircularProgressIndicator());
    }

    return GestureDetector(
      onTap: _toggleControls,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Center(
            child: AspectRatio(
              aspectRatio: c.value.aspectRatio == 0 ? 16 / 9 : c.value.aspectRatio,
              child: VideoPlayer(c),
            ),
          ),
          // Mid-stream buffering — a spinner so a stalling stream doesn't read
          // as a frozen frame.
          if (c.value.isBuffering)
            const CircularProgressIndicator(color: Colors.white),
          if (_showControls) ...[
            GestureDetector(
              onTap: _togglePlay,
              child: Container(
                decoration: const BoxDecoration(
                  color: Colors.black54,
                  shape: BoxShape.circle,
                ),
                padding: const EdgeInsets.all(12),
                child: Icon(
                  c.value.isPlaying ? Icons.pause : Icons.play_arrow,
                  color: Colors.white,
                  size: 44,
                ),
              ),
            ),
            Positioned(
              left: 12,
              right: 12,
              bottom: 16,
              child: VideoProgressIndicator(
                c,
                allowScrubbing: true,
                colors: const VideoProgressColors(
                  playedColor: Colors.white,
                  bufferedColor: Colors.white38,
                  backgroundColor: Colors.white24,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _centered(Widget child) => Container(
        color: Colors.black,
        alignment: Alignment.center,
        padding: const EdgeInsets.all(24),
        child: child,
      );
}
