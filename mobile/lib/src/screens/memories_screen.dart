// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Memories ("On this day") — native parity with the web /app/memories grouped
// view. Year sections (newest first), each a 3-col thumbnail grid; a calendar
// action in the app bar re-picks the day. Tapping a tile opens the detail
// pager scoped to that year's assets.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";
import "asset_detail_screen.dart";

class MemoriesScreen extends StatefulWidget {
  const MemoriesScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<MemoriesScreen> createState() => _MemoriesScreenState();
}

class _MemoriesScreenState extends State<MemoriesScreen> {
  bool _loading = true;
  String? _error;
  DateTime _date = DateTime.now();
  List<MemoryYear> _years = const [];
  final Map<String, String> _thumbs = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  static String _fmtDate(DateTime d) =>
      "${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}";

  static const _months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  String get _headline => "${_months[_date.month - 1]} ${_date.day}";

  String _yearsAgo(int year) {
    final diff = _date.year - year;
    if (diff <= 0) return "This year";
    if (diff == 1) return "1 year ago";
    return "$diff years ago";
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final years = await widget.client.memories(date: _fmtDate(_date));
      final ids = <String>[
        for (final y in years)
          for (final a in y.assets) a.id,
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
        _years = years;
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

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(1970),
      lastDate: DateTime(now.year + 1),
    );
    if (picked == null || !mounted) return;
    setState(() => _date = picked);
    _load();
  }

  Future<void> _openDetail(List<Asset> set, int i) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>?>(
      MaterialPageRoute(
        builder: (_) => AssetDetailScreen(
          client: widget.client,
          assets: set,
          initialIndex: i,
        ),
      ),
    );
    if (!mounted || result == null) return;
    final trashedId = result["trashedId"] as String?;
    if (trashedId != null) {
      setState(() {
        _years = _years
            .map((y) => MemoryYear(
                  year: y.year,
                  count: y.count,
                  assets: y.assets.where((a) => a.id != trashedId).toList(),
                ))
            .toList();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Memories"),
        actions: [
          TextButton.icon(
            onPressed: _pickDate,
            icon: const Icon(Icons.calendar_today, size: 18),
            label: Text(_headline),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return _loadingSkeleton();
    if (_error != null) return ListErrorState(onRetry: _load);
    if (_years.isEmpty) {
      return ListEmptyState(
        icon: Icons.auto_awesome,
        message: "No memories from $_headline in prior years yet.\n"
            "Upload photos with capture dates to start building memories.",
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.only(bottom: 16),
        itemCount: _years.length,
        itemBuilder: (context, i) => _yearSection(_years[i]),
      ),
    );
  }

  /// Skeleton grid shown while the first fetch is in flight — reads smoother
  /// into the real thumbnail grid than a lone centered spinner. Reuses the
  /// shared `imageSkeleton` token so dark mode stays neutral.
  Widget _loadingSkeleton() {
    return GridView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        mainAxisSpacing: 2,
        crossAxisSpacing: 2,
      ),
      itemCount: 12,
      itemBuilder: (context, _) => imageSkeleton(context),
    );
  }

  Widget _yearSection(MemoryYear y) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 16, 12, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                _yearsAgo(y.year),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  "$_headline, ${y.year}",
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.outline,
                      ),
                ),
              ),
              Text(
                "${y.count}",
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.outline,
                    ),
              ),
            ],
          ),
        ),
        GridView.builder(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            mainAxisSpacing: 2,
            crossAxisSpacing: 2,
          ),
          itemCount: y.assets.length,
          itemBuilder: (context, i) {
            final a = y.assets[i];
            final url = _thumbs[a.id];
            return GestureDetector(
              onTap: () => _openDetail(y.assets, i),
              child: url == null
                  ? imageSkeleton(context)
                  : CachedNetworkImage(
                      imageUrl: url,
                      fit: BoxFit.cover,
                      memCacheWidth: 260,
                      memCacheHeight: 260,
                      placeholder: (ctx, _) => imageSkeleton(ctx),
                      errorWidget: (ctx, _, __) => ColoredBox(
                        color: Theme.of(ctx).colorScheme.surfaceContainerHighest,
                        child: const Icon(Icons.broken_image),
                      ),
                    ),
            );
          },
        ),
      ],
    );
  }
}
