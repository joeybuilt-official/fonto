// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Post-login landing. Loads stats + a thumbnail-resolved page of
// recent assets. FAB → camera capture → multipart upload. Long-press
// the app-bar avatar → sign out.
//
// This screen is intentionally minimal for the 6.2 scaffold. Future
// passes layer in: pagination (/api/v1/sync/assets cursor), grouping
// by capturedAt, folder browse, search bar.

import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";
import "package:image_picker/image_picker.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../state/auth_store.dart";

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, required this.onSignOut});

  final AuthStore auth;
  final VoidCallback onSignOut;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final FontoClient _client = FontoClient(widget.auth);
  final _picker = ImagePicker();

  bool _loading = true;
  String? _error;
  WorkspaceStats? _stats;
  List<Asset> _assets = const [];
  Map<String, String> _thumbs = const {};
  bool _uploading = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _client.close();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final stats = await _client.stats();
      final assets = await _client.listAssets(limit: 60);
      final thumbs = assets.isEmpty
          ? <String, String>{}
          : await _client.assetUrls(
              assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _stats = stats;
        _assets = assets;
        _thumbs = thumbs;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = "${e.status}: ${e.message}";
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

  Future<void> _captureAndUpload() async {
    final picked = await _picker.pickImage(source: ImageSource.camera);
    if (picked == null) return;
    setState(() => _uploading = true);
    try {
      await _client.uploadFile(File(picked.path));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Uploaded.")),
      );
      await _refresh();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Upload failed: ${e.status} ${e.message}")),
      );
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _signOut() async {
    await widget.auth.clear();
    if (!mounted) return;
    widget.onSignOut();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Fonto"),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _refresh,
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: "Sign out",
            onPressed: _signOut,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _uploading ? null : _captureAndUpload,
        child: _uploading
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.camera_alt),
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
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
              FilledButton(onPressed: _refresh, child: const Text("Retry")),
            ],
          ),
        ),
      );
    }

    return Column(
      children: [
        if (_stats != null) _StatsBar(stats: _stats!),
        Expanded(child: _AssetGrid(assets: _assets, thumbs: _thumbs)),
      ],
    );
  }
}

class _StatsBar extends StatelessWidget {
  const _StatsBar({required this.stats});

  final WorkspaceStats stats;

  @override
  Widget build(BuildContext context) {
    final pairs = <(String, int)>[
      ("Total", stats.total),
      ("Images", stats.images),
      ("Videos", stats.videos),
      ("Docs", stats.documents),
      ("★", stats.favorites),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: pairs
            .map((p) => Column(
                  children: [
                    Text(
                      "${p.$2}",
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      p.$1,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ],
                ))
            .toList(),
      ),
    );
  }
}

class _AssetGrid extends StatelessWidget {
  const _AssetGrid({required this.assets, required this.thumbs});

  final List<Asset> assets;
  final Map<String, String> thumbs;

  @override
  Widget build(BuildContext context) {
    if (assets.isEmpty) {
      return const Center(child: Text("No assets yet. Tap the camera FAB."));
    }
    return GridView.builder(
      padding: const EdgeInsets.all(4),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        crossAxisSpacing: 4,
        mainAxisSpacing: 4,
      ),
      itemCount: assets.length,
      itemBuilder: (context, i) {
        final a = assets[i];
        final url = thumbs[a.id];
        if (url == null) {
          return Container(color: Colors.black12);
        }
        return CachedNetworkImage(
          imageUrl: url,
          fit: BoxFit.cover,
          placeholder: (_, __) => Container(color: Colors.black12),
          errorWidget: (_, __, ___) => const Icon(Icons.broken_image),
        );
      },
    );
  }
}
