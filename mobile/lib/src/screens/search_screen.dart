// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Text search. Hits /api/v1/search which covers filename, description,
// and OCR text. No pagination today (the server endpoint doesn't
// expose a cursor) — capped at whatever the server returns in one shot.

import "package:cached_network_image/cached_network_image.dart";
import "package:connectivity_plus/connectivity_plus.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";
import "asset_detail_screen.dart";

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _ctrl = TextEditingController();
  bool _busy = false;
  String? _error;
  // Search results aren't cached (the endpoint has no clean offline shape), so
  // when a query fails offline we show a dedicated "needs connection" state
  // rather than a generic error.
  bool _offline = false;
  List<Asset> _results = const [];
  Map<String, String> _thumbs = const {};

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    final q = _ctrl.text.trim();
    if (q.isEmpty) {
      setState(() {
        _results = const [];
        _thumbs = const {};
        _error = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _offline = false;
    });
    try {
      final assets = await widget.client.search(q);
      final thumbs = assets.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(
              assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _results = assets;
        _thumbs = thumbs;
        _busy = false;
      });
    } on ApiException catch (e) {
      await _fail("${e.status}: ${e.message}");
    } catch (e) {
      await _fail(e.toString());
    }
  }

  Future<void> _fail(String msg) async {
    final offline = await _isOffline();
    if (!mounted) return;
    setState(() {
      _offline = offline;
      _error = msg;
      _busy = false;
    });
  }

  Future<bool> _isOffline() async {
    try {
      final results = await Connectivity().checkConnectivity();
      return !results.any((r) => r != ConnectivityResult.none);
    } catch (_) {
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _ctrl,
          autofocus: true,
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => _run(),
          decoration: const InputDecoration(
            border: InputBorder.none,
            hintText: "Search filenames, descriptions, OCR…",
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.search),
            onPressed: _busy ? null : _run,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Future<void> _openDetail(int i) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>?>(
      MaterialPageRoute(
        builder: (_) => AssetDetailScreen(
          client: widget.client,
          assets: _results,
          initialIndex: i,
        ),
      ),
    );
    if (!mounted || result == null) return;
    final trashedId = result["trashedId"] as String?;
    if (trashedId != null) {
      setState(
        () => _results = _results.where((a) => a.id != trashedId).toList(),
      );
    }
  }

  Widget _buildBody() {
    if (_busy) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return ListErrorState(
        message: _offline
            ? "You're offline — search needs a connection. "
                "Your saved library is still available on the Library tab."
            : "Couldn't run that search. Check your connection and retry.",
        onRetry: _run,
      );
    }
    if (_results.isEmpty) {
      final hasQuery = _ctrl.text.trim().isNotEmpty;
      return ListEmptyState(
        icon: Icons.search,
        message: hasQuery
            ? "No assets found."
            : "Type to search your assets, or set a filter.",
      );
    }
    return GridView.builder(
      padding: const EdgeInsets.all(4),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        crossAxisSpacing: 4,
        mainAxisSpacing: 4,
      ),
      itemCount: _results.length,
      itemBuilder: (context, i) {
        final a = _results[i];
        final url = _thumbs[a.id];
        final tile = url == null
            ? imageSkeleton(context)
            : Hero(
                tag: a.id,
                child: CachedNetworkImage(
                  imageUrl: url,
                  fit: BoxFit.cover,
                  placeholder: (ctx, _) => imageSkeleton(ctx),
                  errorWidget: (_, __, ___) =>
                      const Icon(Icons.broken_image),
                ),
              );
        return GestureDetector(
          onTap: () => _openDetail(i),
          child: tile,
        );
      },
    );
  }
}
