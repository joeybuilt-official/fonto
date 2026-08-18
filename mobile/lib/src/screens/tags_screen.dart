// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M10 / ADR 0013 — Manage tags (native parity with web /app/tags). A nested
// tree where you add a sub-tag, rename, or move (re-parent). Hierarchy is
// parentId + a materialized path; filtering a parent elsewhere shows all of
// its descendants' photos (resolved server-side). No deletes here.

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";

class TagsScreen extends StatefulWidget {
  const TagsScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<TagsScreen> createState() => _TagsScreenState();
}

class _TagsScreenState extends State<TagsScreen> {
  bool _loading = true;
  String? _error;
  List<TagNode> _tags = const [];
  final Set<String> _collapsed = {};
  bool _busy = false;

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
      final tags = await widget.client.listTags();
      if (!mounted) return;
      setState(() {
        _tags = tags;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Map<String?, List<TagNode>> get _byParent {
    final m = <String?, List<TagNode>>{};
    for (final t in _tags) {
      (m[t.parentId] ??= []).add(t);
    }
    for (final list in m.values) {
      list.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    }
    return m;
  }

  // Depth-first flatten of the visible tree (children of collapsed nodes hidden).
  List<({TagNode tag, int depth})> _flatten() {
    final byParent = _byParent;
    final out = <({TagNode tag, int depth})>[];
    void walk(String? parentId, int depth) {
      for (final t in byParent[parentId] ?? const <TagNode>[]) {
        out.add((tag: t, depth: depth));
        if (!_collapsed.contains(t.id)) walk(t.id, depth + 1);
      }
    }

    walk(null, 0);
    return out;
  }

  Future<void> _run(Future<void> Function() op) async {
    HapticFeedback.selectionClick();
    setState(() => _busy = true);
    try {
      await op();
      await _silentReload();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Couldn't save: $e")));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // Refetch the tree without toggling `_loading`, so a single add/rename/move
  // never blanks the whole tree to a centered spinner (heavy flicker on a
  // trivial edit). The tree simply updates in place; `_run` already surfaces
  // op failures via snackbar and keeps the current tree on a refetch error.
  Future<void> _silentReload() async {
    try {
      final tags = await widget.client.listTags();
      if (!mounted) return;
      setState(() => _tags = tags);
    } catch (_) {
      // Keep the existing tree; the mutation itself already succeeded.
    }
  }

  Future<String?> _promptName({String title = "New tag", String initial = ""}) {
    final ctrl = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(hintText: "Tag name"),
          onSubmitted: (v) => Navigator.of(ctx).pop(v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text("Cancel")),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text("Save"),
          ),
        ],
      ),
    ).whenComplete(ctrl.dispose);
  }

  Future<void> _move(TagNode node) async {
    // Valid targets exclude the node itself and its descendants (cycle guard).
    // Match on a path *boundary* so a sibling sharing a leaf-id prefix (e.g.
    // "a/b2" vs node "a/b") isn't wrongly excluded. Works whether or not the
    // materialized path carries a trailing delimiter.
    final base = node.path.endsWith("/") ? node.path : "${node.path}/";
    final targets = _tags
        .where((t) => t.path != node.path && !t.path.startsWith(base))
        .toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    final selected = await showDialog<({bool root, String? id})>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text("Move under…"),
        children: [
          SimpleDialogOption(
            onPressed: () => Navigator.of(ctx).pop((root: true, id: null)),
            child: const Text("— Top level —"),
          ),
          for (final t in targets)
            SimpleDialogOption(
              onPressed: () => Navigator.of(ctx).pop((root: false, id: t.id)),
              child: Text(t.name),
            ),
        ],
      ),
    );
    if (selected == null) return;
    await _run(() => widget.client.updateTag(node.id, parentId: selected.id));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Manage tags"),
        actions: [
          IconButton(
            tooltip: "New tag",
            icon: const Icon(Icons.add),
            onPressed: _busy
                ? null
                : () async {
                    final name = await _promptName();
                    if (name != null && name.isNotEmpty) {
                      await _run(() => widget.client.createTag(name));
                    }
                  },
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return ListErrorState(onRetry: _load);

    final rows = _flatten();
    if (rows.isEmpty) {
      return const ListEmptyState(
        icon: Icons.sell_outlined,
        message: "No tags yet. Tap + to create one.",
      );
    }

    final byParent = _byParent;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: rows.length,
        itemBuilder: (context, i) {
          final row = rows[i];
          final t = row.tag;
          final hasKids = (byParent[t.id] ?? const []).isNotEmpty;
          final isCollapsed = _collapsed.contains(t.id);
          return Padding(
            padding: EdgeInsets.only(left: 8.0 + row.depth * 18, right: 4),
            child: Row(
              children: [
                if (hasKids)
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: Icon(isCollapsed ? Icons.chevron_right : Icons.expand_more, size: 20),
                    onPressed: () => setState(() {
                      if (isCollapsed) {
                        _collapsed.remove(t.id);
                      } else {
                        _collapsed.add(t.id);
                      }
                    }),
                  )
                else
                  const SizedBox(width: 40),
                Container(
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(
                    color: _parseColor(t.color),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(t.name, overflow: TextOverflow.ellipsis),
                ),
                PopupMenuButton<String>(
                  enabled: !_busy,
                  onSelected: (v) async {
                    switch (v) {
                      case "add":
                        final name = await _promptName(title: "New sub-tag");
                        if (name != null && name.isNotEmpty) {
                          await _run(() => widget.client.createTag(name, parentId: t.id));
                        }
                      case "rename":
                        final name = await _promptName(title: "Rename", initial: t.name);
                        if (name != null && name.isNotEmpty && name != t.name) {
                          await _run(() => widget.client.updateTag(t.id, name: name));
                        }
                      case "move":
                        await _move(t);
                    }
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: "add", child: Text("Add sub-tag")),
                    PopupMenuItem(value: "rename", child: Text("Rename")),
                    PopupMenuItem(value: "move", child: Text("Move")),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

Color _parseColor(String hex) {
  var h = hex.replaceFirst("#", "");
  if (h.length == 6) h = "FF$h";
  final v = int.tryParse(h, radix: 16);
  return v == null ? const Color(0xFF6366F1) : Color(v);
}
