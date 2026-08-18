// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0010 — user-facing duplicates review (native parity with the web
// /app/duplicates page). Lists candidate near-duplicate groups; per group the
// user can "Keep best, trash rest" (reversible consolidation) or "Not
// duplicates" (dismiss). Thumbnails only — the heavy SSIM scoring stays the
// owner-only web Tidy Up tool.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";

class DuplicatesScreen extends StatefulWidget {
  const DuplicatesScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<DuplicatesScreen> createState() => _DuplicatesScreenState();
}

class _DuplicatesScreenState extends State<DuplicatesScreen> {
  bool _loading = true;
  String? _error;
  List<DupGroup> _groups = const [];
  final Map<String, String> _thumbs = {};
  final Set<String> _busy = {};

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
      final groups = await widget.client.listDuplicates();
      final ids = <String>[
        for (final g in groups)
          for (final m in g.members) m.id,
      ];
      Map<String, String> thumbs = const {};
      if (ids.isNotEmpty) {
        try {
          thumbs = await widget.client.assetUrls(ids, variant: "thumb");
        } catch (_) {
          thumbs = const {};
        }
      }
      if (!mounted) return;
      setState(() {
        _groups = groups;
        _thumbs
          ..clear()
          ..addAll(thumbs);
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

  // Guard the one-tap destructive path with a confirm dialog (there's no
  // in-context Undo for a group consolidation), then trash on confirm.
  Future<void> _confirmResolve(DupGroup g) async {
    final n = g.members.length;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Keep best, trash the rest?"),
        content: Text(
          "We'll keep the best of these $n and move the other "
          "${n - 1} to Trash. They stay recoverable from Trash.",
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text("Cancel"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text("Keep best, trash rest"),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    HapticFeedback.mediumImpact();
    await _act(g, true);
  }

  Future<void> _act(DupGroup g, bool resolve) async {
    setState(() => _busy.add(g.groupId));
    try {
      if (resolve) {
        await widget.client.resolveDuplicate(g.groupId);
      } else {
        await widget.client.dismissDuplicate(g.groupId);
      }
      if (!mounted) return;
      setState(() {
        _groups = _groups.where((x) => x.groupId != g.groupId).toList();
        _busy.remove(g.groupId);
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(resolve
              ? "Kept best, trashed the rest (recoverable)."
              : "Marked as not duplicates."),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy.remove(g.groupId));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't update: $e")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Duplicates")),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const ListSkeleton(count: 6);
    if (_error != null) return ListErrorState(onRetry: _load);
    if (_groups.isEmpty) {
      return const ListEmptyState(
        icon: Icons.copy_all_outlined,
        message: "No duplicate groups to review. Nice and tidy.",
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _groups.length,
        itemBuilder: (context, i) => _groupCard(_groups[i]),
      ),
    );
  }

  Widget _groupCard(DupGroup g) {
    final busy = _busy.contains(g.groupId);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "${g.members.length} similar items",
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 88,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: g.members.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, j) {
                  final m = g.members[j];
                  final url = _thumbs[m.id];
                  return ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: SizedBox(
                      width: 88,
                      height: 88,
                      child: url == null
                          ? imageSkeleton(context)
                          : CachedNetworkImage(
                              imageUrl: url,
                              fit: BoxFit.cover,
                              memCacheWidth: 200,
                              placeholder: (ctx, _) => imageSkeleton(ctx),
                              errorWidget: (ctx, _, __) => ColoredBox(
                                color: Theme.of(ctx)
                                    .colorScheme
                                    .surfaceContainerHighest,
                                child: const Icon(Icons.broken_image),
                              ),
                            ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: busy ? null : () => _confirmResolve(g),
                    icon: const Icon(Icons.check, size: 18),
                    label: const Text("Keep best, trash rest"),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: busy
                      ? null
                      : () {
                          HapticFeedback.selectionClick();
                          _act(g, false);
                        },
                  child: const Text("Not dupes"),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
