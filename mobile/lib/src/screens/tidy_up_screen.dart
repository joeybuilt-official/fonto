// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M15.3 — "Tidy Up" reason-bucket review, native parity with the web
// /app/review date lane. Each bucket is one trust-ramp card: a sample
// filmstrip + honest count, a plain-language title, a confidence chip, and a
// single action that applies to the whole bucket (server-resolved). Bulk
// actions are reversible (snackbar Undo). Owner-gated server-side; a non-owner
// sees an "owner only" message. No admin jargon.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";

const Map<String, String> _sourcePhrase = {
  "exif": "the photo's own info",
  "filename": "the file name",
  "ocr_date": "a date printed in the photo",
  "fs_mtime": "the file's saved date",
  "identity_bound": "who's in the photo",
  "apparent_age": "people's ages",
  "trip_match": "a matching trip",
  "scene_season": "the season it looks like",
  "cluster_propagation": "similar photos nearby",
  "co_occurrence": "photos taken around it",
};
String _phrase(String? s) => (s != null ? _sourcePhrase[s] : null) ?? "other clues";

const Map<String, String> _tierLabel = {
  "high": "Very likely right",
  "medium": "Probably right",
  "low": "Worth a look",
};

const List<String> _months = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

String _fmtDate(String? iso, {String? precision}) {
  if (iso == null || iso.isEmpty) return "no date";
  final d = DateTime.tryParse(iso);
  if (d == null) return "no date";
  if (precision == "year") return "${d.year}";
  return "${_months[d.month - 1]} ${d.year}";
}

class TidyUpScreen extends StatefulWidget {
  const TidyUpScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<TidyUpScreen> createState() => _TidyUpScreenState();
}

class _TidyUpScreenState extends State<TidyUpScreen> {
  bool _loading = true;
  String? _error;
  bool _forbidden = false;
  ReviewBuckets? _data;
  final Map<String, String> _thumbs = {};
  final Set<String> _busy = {};
  final Set<String> _hidden = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _forbidden = false;
    });
    try {
      final data = await widget.client.listReviewBuckets();
      final ids = <String>[
        for (final b in data.buckets)
          for (final s in b.sample) s.assetId,
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
        _data = data;
        _hidden.clear();
        _thumbs
          ..clear()
          ..addAll(thumbs);
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.status == 403) {
        setState(() {
          _forbidden = true;
          _loading = false;
        });
        return;
      }
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

  Future<void> _apply(ReviewBucket b, String action) async {
    setState(() {
      _busy.add(b.bucketId);
      _hidden.add(b.bucketId);
    });
    try {
      await widget.client.applyReviewBucket(
        evidenceSource: b.evidenceSource,
        conflict: b.conflict,
        action: action,
      );
      if (!mounted) return;
      setState(() => _busy.remove(b.bucketId));
      final n = b.count;
      final msg = action == "confirm"
          ? "Fixing $n date${n == 1 ? "" : "s"}"
          : "Keeping the saved date for $n photo${n == 1 ? "" : "s"}";
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(msg),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(label: "Undo", onPressed: () => _undo(b)),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy.remove(b.bucketId);
        _hidden.remove(b.bucketId);
      });
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("Couldn't apply: $e")));
    }
  }

  Future<void> _undo(ReviewBucket b) async {
    try {
      await widget.client
          .undoReviewBucket(evidenceSource: b.evidenceSource, conflict: b.conflict);
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text("Undone.")));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("Couldn't undo: $e")));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Tidy up")),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_forbidden) {
      return const ListEmptyState(
        icon: Icons.lock_outline,
        message: "Tidy Up is available to the workspace owner.",
      );
    }
    if (_error != null) return ListErrorState(onRetry: _load);

    final data = _data;
    final buckets =
        (data?.buckets ?? const <ReviewBucket>[]).where((b) => !_hidden.contains(b.bucketId)).toList();
    final sorted = data?.progressSorted;
    final total = data?.progressTotal;
    final sorting = sorted != null && total != null && total > 0 && sorted < total;

    if (buckets.isEmpty && !sorting) {
      return const ListEmptyState(
        icon: Icons.check_circle_outline,
        message: "Your library's tidy. Nothing to review right now.",
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (sorting) _progressBanner(sorted, total),
          if (buckets.isEmpty && sorting)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text("Nothing to check yet — come back as more photos finish sorting."),
              ),
            ),
          ...buckets.map(_bucketCard),
          _safetyLine(context),
        ],
      ),
    );
  }

  Widget _progressBanner(int sorted, int total) {
    final pct = (sorted / total).clamp(0.0, 1.0);
    return Card(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "Sorting your library… $sorted of $total photos",
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(value: pct, minHeight: 6),
            ),
            const SizedBox(height: 8),
            Text(
              "We're working out when each photo was taken. More to review will appear as this finishes — nothing you need to do yet.",
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  Widget _safetyLine(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(Icons.shield_outlined,
              size: 18, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              "Nothing is deleted here. Date changes can be undone any time.",
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }

  Color _tierColor(BuildContext context, String tier) {
    final scheme = Theme.of(context).colorScheme;
    switch (tier) {
      case "high":
        return scheme.secondaryContainer;
      case "medium":
        return scheme.tertiaryContainer;
      default:
        return scheme.surfaceContainerHighest;
    }
  }

  Widget _bucketCard(ReviewBucket b) {
    final busy = _busy.contains(b.bucketId);
    final phrase = _phrase(b.evidenceSource);
    final title = b.conflict
        ? "The saved date looks wrong for these"
        : "These got their date from $phrase";
    final sub = b.conflict
        ? "We think the right date comes from $phrase."
        : (b.confidenceTier == "high" ? null : "Peek before you apply.");
    final strip = b.sample.take(5).toList();
    final remainder = b.count - strip.length;
    final first = b.sample.isNotEmpty ? b.sample.first : null;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(title, style: Theme.of(context).textTheme.titleMedium),
                ),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: _tierColor(context, b.confidenceTier),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    _tierLabel[b.confidenceTier] ?? "Worth a look",
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
              ],
            ),
            if (sub != null) ...[
              const SizedBox(height: 4),
              Text(sub, style: Theme.of(context).textTheme.bodyMedium),
            ],
            const SizedBox(height: 10),
            SizedBox(
              height: 56,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: strip.length + (remainder > 0 ? 1 : 0),
                separatorBuilder: (_, __) => const SizedBox(width: 6),
                itemBuilder: (_, j) {
                  if (j >= strip.length) {
                    return Container(
                      width: 56,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text("+$remainder",
                          style: Theme.of(context).textTheme.labelMedium),
                    );
                  }
                  final url = _thumbs[strip[j].assetId];
                  return ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: SizedBox(
                      width: 56,
                      height: 56,
                      child: url == null
                          ? imageSkeleton(context)
                          : CachedNetworkImage(
                              imageUrl: url,
                              fit: BoxFit.cover,
                              memCacheWidth: 160,
                              placeholder: (ctx, _) => imageSkeleton(ctx),
                              errorWidget: (ctx, _, __) => ColoredBox(
                                color: Theme.of(ctx).colorScheme.surfaceContainerHighest,
                                child: const Icon(Icons.broken_image),
                              ),
                            ),
                    ),
                  );
                },
              ),
            ),
            if (b.conflict && first != null) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text("Saved ${_fmtDate(first.capturedAt)}",
                        style: Theme.of(context).textTheme.bodySmall),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 6),
                      child: Icon(Icons.arrow_forward, size: 14),
                    ),
                    Text(
                      "Photo says ${_fmtDate(first.mapEstimate, precision: first.mapPrecision)}",
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(fontWeight: FontWeight.w500),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                FilledButton.icon(
                  onPressed: busy ? null : () => _apply(b, "confirm"),
                  icon: const Icon(Icons.check, size: 18),
                  label: Text(b.conflict
                      ? "Looks right — fix all ${b.count}"
                      : "Use these dates"),
                ),
                if (b.conflict)
                  OutlinedButton(
                    onPressed: busy ? null : () => _apply(b, "reject"),
                    child: const Text("Keep saved dates"),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
