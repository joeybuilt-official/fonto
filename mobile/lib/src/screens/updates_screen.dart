// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Updates tab. Phase 6.15 — one compact, scrollable activity feed.
// Replaces the old three-tab (Uploads / Activity / Shared) layout whose
// Uploads/Shared tabs were full-size 3-column thumbnail grids. Now a
// single cursor-paginated feed of activity_events: actor avatar/initials
// + a human-readable summary + an inline micro-thumb (when the event
// references an asset) + relative timestamp. Uploads and shares surface
// here because the backend now emits 'asset.uploaded' and 'asset.shared'
// activity events (see lib/activity/emit.ts). Tapping a row that carries
// an assetId opens the asset detail screen.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "asset_detail_screen.dart";

class UpdatesScreen extends StatelessWidget {
  const UpdatesScreen({super.key, required this.client});

  final FontoClient client;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Updates")),
      body: _ActivityFeed(client: client),
    );
  }
}

/// The single Updates feed: loading / error+retry / empty / data, mirroring
/// the state machine used elsewhere (home_screen.dart).
class _ActivityFeed extends StatefulWidget {
  const _ActivityFeed({required this.client});
  final FontoClient client;

  @override
  State<_ActivityFeed> createState() => _ActivityFeedState();
}

class _ActivityFeedState extends State<_ActivityFeed> {
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  final List<ActivityEvent> _events = [];
  // assetId -> thumb URL, accumulated as pages load.
  final Map<String, String> _thumbs = {};
  String? _cursor;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _events.clear();
      _thumbs.clear();
      _cursor = null;
    });
    try {
      final page = await widget.client.listActivity(limit: 50);
      await _hydrateThumbs(page.events);
      if (!mounted) return;
      setState(() {
        _events.addAll(page.events);
        _cursor = page.nextCursor;
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  Future<void> _loadMore() async {
    if (_cursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final page = await widget.client.listActivity(
        limit: 50,
        createdBefore: _cursor,
      );
      await _hydrateThumbs(page.events);
      if (!mounted) return;
      setState(() {
        _events.addAll(page.events);
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Load failed: $e")),
      );
    }
  }

  /// Fetch thumb URLs for any asset-referencing events we haven't resolved
  /// yet, in one batched call. Failures are non-fatal — a row just renders
  /// without its micro-thumb.
  Future<void> _hydrateThumbs(List<ActivityEvent> events) async {
    final ids = <String>{};
    for (final e in events) {
      final id = _assetIdOf(e);
      if (id != null && !_thumbs.containsKey(id)) ids.add(id);
    }
    if (ids.isEmpty) return;
    try {
      final urls = await widget.client.assetUrls(ids.toList(), variant: "thumb");
      _thumbs.addAll(urls);
    } catch (_) {
      // ignore — micro-thumbs are best-effort.
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _error = msg;
      _loading = false;
    });
  }

  Future<void> _openAsset(String assetId) async {
    try {
      final asset = await widget.client.getAsset(assetId);
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => AssetDetailScreen(
            client: widget.client,
            assets: [asset],
            initialIndex: 0,
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't open asset: $e")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 40),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: _load, child: const Text("Retry")),
            ],
          ),
        ),
      );
    }
    if (_events.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            "No activity yet. Uploads, shares, and comments show up here.",
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 4),
        itemCount: _events.length + (_cursor != null ? 1 : 0),
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          if (i >= _events.length) {
            return Padding(
              padding: const EdgeInsets.all(12),
              child: Center(
                child: _loadingMore
                    ? const CircularProgressIndicator()
                    : OutlinedButton(
                        onPressed: _loadMore,
                        child: const Text("Load more"),
                      ),
              ),
            );
          }
          final event = _events[i];
          final assetId = _assetIdOf(event);
          return _FeedRow(
            event: event,
            thumbUrl: assetId == null ? null : _thumbs[assetId],
            onTap: assetId == null ? null : () => _openAsset(assetId),
          );
        },
      ),
    );
  }
}

/// One compact feed row: actor avatar + summary + relative time, with an
/// optional trailing micro-thumb when the event references an asset.
class _FeedRow extends StatelessWidget {
  const _FeedRow({required this.event, this.thumbUrl, this.onTap});

  final ActivityEvent event;
  final String? thumbUrl;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            _Avatar(actorUserId: event.actorUserId, kind: event.kind),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _summarize(event),
                    style: theme.textTheme.bodyMedium,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _relativeTime(event.createdAt),
                    style: theme.textTheme.labelSmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ),
            ),
            if (thumbUrl != null) ...[
              const SizedBox(width: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: CachedNetworkImage(
                  imageUrl: thumbUrl!,
                  width: 32,
                  height: 32,
                  fit: BoxFit.cover,
                  placeholder: (_, __) => Container(
                    width: 32,
                    height: 32,
                    color: Colors.black12,
                  ),
                  errorWidget: (_, __, ___) => Container(
                    width: 32,
                    height: 32,
                    color: Colors.black12,
                    child: const Icon(Icons.broken_image, size: 16),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Circular actor avatar — initials from the actor id, tinted by a stable
/// hash so distinct actors read apart at a glance. Falls back to a
/// kind-specific icon for system (actor-less) events.
class _Avatar extends StatelessWidget {
  const _Avatar({required this.actorUserId, required this.kind});

  final String? actorUserId;
  final String kind;

  @override
  Widget build(BuildContext context) {
    const size = 36.0;
    if (actorUserId == null || actorUserId!.isEmpty) {
      return CircleAvatar(
        radius: size / 2,
        backgroundColor: Colors.black12,
        child: Icon(_iconFor(kind), size: 18),
      );
    }
    final initials = actorUserId!.length >= 2
        ? actorUserId!.substring(0, 2).toUpperCase()
        : actorUserId!.toUpperCase();
    final hue = (actorUserId!.hashCode & 0x7fffffff) % 360;
    final bg = HSLColor.fromAHSL(1, hue.toDouble(), 0.5, 0.45).toColor();
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: bg,
      child: Text(
        initials,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// assetId an event points at, or null. Prefers explicit payload.assetId,
/// falls back to the soft-FK targetId when the target is an asset.
String? _assetIdOf(ActivityEvent e) {
  final p = e.payload["assetId"];
  if (p is String && p.isNotEmpty) return p;
  if (e.targetType == "asset" && e.targetId != null && e.targetId!.isNotEmpty) {
    return e.targetId;
  }
  return null;
}

IconData _iconFor(String kind) {
  switch (kind) {
    case "comment.posted":
    case "comment.deleted":
      return Icons.mode_comment_outlined;
    case "asset.uploaded":
      return Icons.upload_outlined;
    case "asset.shared":
      return Icons.share_outlined;
    default:
      return Icons.bolt_outlined;
  }
}

/// Mirrors the web activity-section summarize(): actor is the first 8
/// chars of the user id (or "someone"); message varies by kind.
String _summarize(ActivityEvent e) {
  final id = e.actorUserId;
  final actor = (id != null && id.isNotEmpty)
      ? (id.length <= 8 ? id : id.substring(0, 8))
      : "someone";
  switch (e.kind) {
    case "comment.posted":
      final excerpt = e.payload["excerpt"];
      return excerpt is String && excerpt.isNotEmpty
          ? "$actor commented: $excerpt"
          : "$actor posted a comment";
    case "comment.deleted":
      return "$actor deleted a comment";
    case "asset.uploaded":
      return "$actor uploaded a new asset";
    case "asset.shared":
      return "$actor shared an asset with the workspace";
    default:
      return "$actor · ${e.kind}";
  }
}

String _relativeTime(DateTime t) {
  final mins = DateTime.now().difference(t).inMinutes;
  if (mins < 1) return "just now";
  if (mins < 60) return "${mins}m";
  final hrs = mins ~/ 60;
  if (hrs < 24) return "${hrs}h";
  final days = hrs ~/ 24;
  if (days < 7) return "${days}d";
  return "${t.year}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}";
}
