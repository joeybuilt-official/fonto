// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Text search. Hits /api/v1/search which covers filename, description,
// and OCR text. No pagination today (the server endpoint doesn't
// expose a cursor) — capped at whatever the server returns in one shot.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
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
      if (!mounted) return;
      setState(() {
        _error = "${e.status}: ${e.message}";
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _busy = false;
      });
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
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_error!, textAlign: TextAlign.center),
        ),
      );
    }
    if (_results.isEmpty) {
      return const Center(child: Text("Type a query and hit search."));
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
            ? Container(color: Colors.black12)
            : Hero(
                tag: a.id,
                child: CachedNetworkImage(
                  imageUrl: url,
                  fit: BoxFit.cover,
                  placeholder: (_, __) => Container(color: Colors.black12),
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
