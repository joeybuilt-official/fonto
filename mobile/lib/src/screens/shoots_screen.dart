// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Shoots browse screen (ADR 0008/0009) — the native SHOOT-scope opt-out. Lists
// deliberate sessions (newest first) with their asset counts; tapping opens
// that shoot's assets in a SHOOT-scoped grid. This is how shoot work is reached
// on mobile without polluting the PERSONAL timeline.

import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";
import "filtered_assets_screen.dart";

class ShootsScreen extends StatefulWidget {
  const ShootsScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<ShootsScreen> createState() => _ShootsScreenState();
}

class _ShootsScreenState extends State<ShootsScreen> {
  bool _loading = true;
  String? _error;
  List<Shoot> _shoots = const [];

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
      final shoots = await widget.client.listShoots();
      if (!mounted) return;
      setState(() {
        _shoots = shoots;
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

  void _open(Shoot s) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => FilteredAssetsScreen(
          client: widget.client,
          title: s.name,
          shootId: s.id,
          scope: "SHOOT",
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Shoots")),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const ListSkeleton();
    if (_error != null) return ListErrorState(onRetry: _load);
    if (_shoots.isEmpty) {
      return const ListEmptyState(
        icon: Icons.camera_alt_outlined,
        message: "No shoots yet.\n"
            "Shoot work is partitioned from your personal timeline — "
            "reassign assets to a shoot on the web to see them here.",
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        itemCount: _shoots.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final s = _shoots[i];
          return ListTile(
            leading: const Icon(Icons.camera_alt_outlined),
            title: Text(s.name),
            subtitle: s.shootDate == null ? null : Text(s.shootDate!),
            trailing: Text(
              "${s.total}",
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.outline,
                  ),
            ),
            onTap: () => _open(s),
          );
        },
      ),
    );
  }
}
