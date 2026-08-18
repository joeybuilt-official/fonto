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
import "package:flutter/services.dart";

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

// M15.4 (P1-4) — plain-language "why" per evidence source for the bucket expander.
const Map<String, String> _sourceWhy = {
  "exif":
      "Your camera wrote the date inside each of these photos when you took them — usually the most reliable source.",
  "filename": "The date is written into each file's name, like IMG_20180714.jpg.",
  "ocr_date":
      "We spotted a date printed in the photo itself — like a timestamp in a corner.",
  "fs_mtime":
      "We're going by the date the file was last saved. It can be off if the file was copied or re-saved later.",
  "identity_bound": "Based on who appears in the photo and when you knew them.",
  "apparent_age": "Estimated from how old the people in the photo look.",
  "trip_match": "These line up with a trip we already have dates for.",
  "scene_season":
      "The scene looks like a particular season — snow, autumn leaves, and so on.",
  "cluster_propagation": "Borrowed from very similar photos taken right around these.",
  "co_occurrence": "Taken right around other photos with dates we're sure of.",
};
String _why(String? s) =>
    (s != null ? _sourceWhy[s] : null) ?? "We pieced the date together from a few small clues.";

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
  // M15.4 / ADR 0059 — grouping axis (By reason / By folder / By time).
  String _axis = "source";
  ReviewBuckets? _data;
  final Map<String, String> _thumbs = {};
  final Set<String> _busy = {};
  final Set<String> _hidden = {};
  final Set<String> _whyOpen = {}; // P1-4 — expanded "why" per bucket
  // P1-5 — running tally of what this visit cleared, for the summary banner.
  int _fixed = 0;
  int _kept = 0;
  // M15.4 P1-1 — per-item "review one by one" surface. `_reviewOpen` is the
  // bucketId whose individual sample cards are expanded; `_itemHidden` are the
  // sample assets already actioned this visit; `_itemBusy` guards re-taps.
  String? _reviewOpen;
  final Set<String> _itemHidden = {};
  final Set<String> _itemBusy = {};

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
      final data = await widget.client.listReviewBuckets(axis: _axis);
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
        _reviewOpen = null;
        _itemHidden.clear();
        _itemBusy.clear();
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

  // Switch the grouping axis: reset the optimistic state + refetch.
  void _changeAxis(String axis) {
    if (axis == _axis) return;
    HapticFeedback.selectionClick();
    setState(() {
      _axis = axis;
      _hidden.clear();
      _reviewOpen = null;
      _itemHidden.clear();
      _itemBusy.clear();
    });
    _load();
  }

  Widget _axisTabs() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: SegmentedButton<String>(
        showSelectedIcon: false,
        segments: const [
          ButtonSegment(value: "source", label: Text("By reason")),
          ButtonSegment(value: "folder", label: Text("By folder")),
          ButtonSegment(value: "time", label: Text("By time")),
        ],
        selected: {_axis},
        onSelectionChanged:
            _loading ? null : (s) => _changeAxis(s.first),
      ),
    );
  }

  Future<void> _apply(ReviewBucket b, String action) async {
    HapticFeedback.mediumImpact();
    setState(() {
      _busy.add(b.bucketKey);
      _hidden.add(b.bucketKey);
    });
    try {
      await widget.client.applyReviewBucket(
        bucketKey: b.bucketKey,
        action: action,
      );
      if (!mounted) return;
      setState(() {
        _busy.remove(b.bucketKey);
        if (action == "confirm") {
          _fixed += b.count;
        } else {
          _kept += b.count;
        }
      });
      final n = b.count;
      final msg = action == "confirm"
          ? "Fixing $n date${n == 1 ? "" : "s"}"
          : "Keeping the saved date for $n photo${n == 1 ? "" : "s"}";
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(msg),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(label: "Undo", onPressed: () => _undo(b, action)),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy.remove(b.bucketKey);
        _hidden.remove(b.bucketKey);
      });
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("Couldn't apply: $e")));
    }
  }

  Future<void> _undo(ReviewBucket b, String action) async {
    HapticFeedback.lightImpact();
    try {
      await widget.client.undoReviewBucket(bucketKey: b.bucketKey);
      if (!mounted) return;
      // Roll the visit tally back only once the undo actually succeeded (P1-5),
      // otherwise a failed undo would leave the counter too low with the bucket
      // still hidden.
      setState(() {
        if (action == "confirm") {
          _fixed = (_fixed - b.count).clamp(0, 1 << 31);
        } else {
          _kept = (_kept - b.count).clamp(0, 1 << 31);
        }
      });
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
    if (_forbidden) {
      return const ListEmptyState(
        icon: Icons.lock_outline,
        message: "Tidy Up is available to the workspace owner.",
      );
    }
    if (_error != null) return ListErrorState(onRetry: _load);
    if (_loading) {
      // First load has no scaffolding yet — a full-screen spinner is fine.
      if (_data == null) {
        return const Center(child: CircularProgressIndicator());
      }
      // Axis switch / refresh with data already loaded: keep the segmented
      // control (the thing the user just touched) mounted and show an inline
      // loader below it instead of blanking the whole screen.
      return ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _axisTabs(),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Center(child: CircularProgressIndicator()),
          ),
        ],
      );
    }

    final data = _data;
    final buckets =
        (data?.buckets ?? const <ReviewBucket>[]).where((b) => !_hidden.contains(b.bucketKey)).toList();
    final sorted = data?.progressSorted;
    final total = data?.progressTotal;
    final sorting = sorted != null && total != null && total > 0 && sorted < total;

    if (buckets.isEmpty && !sorting) {
      // Keep the axis tabs + visit summary visible even once everything's
      // cleared, so the operator can switch grouping without a reload (P1-5).
      final emptyMsg = _axis == "source"
          ? "Your library's tidy. Nothing to review right now."
          : "Nothing to review in this view.";
      return ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _axisTabs(),
          if (_fixed + _kept > 0) _sessionSummary(context),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Center(
              child: Text(emptyMsg, textAlign: TextAlign.center),
            ),
          ),
        ],
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _axisTabs(),
          if (_fixed + _kept > 0) _sessionSummary(context),
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

  // P1-5 — what this visit tidied; stays put even once everything's clear.
  Widget _sessionSummary(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final parts = <String>[
      if (_fixed > 0) "$_fixed date${_fixed == 1 ? "" : "s"} fixed",
      if (_kept > 0) "$_kept kept as saved",
    ];
    return Card(
      color: scheme.secondaryContainer,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Icon(Icons.auto_awesome, size: 20, color: scheme.onSecondaryContainer),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                "This visit: ${parts.join(" · ")}.",
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: scheme.onSecondaryContainer,
                      fontWeight: FontWeight.w500,
                    ),
              ),
            ),
          ],
        ),
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

  // P1-4 — collapsible plain-language reason for a bucket.
  Widget _whyExpander(ReviewBucket b) {
    final open = _whyOpen.contains(b.bucketKey);
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() {
            if (open) {
              _whyOpen.remove(b.bucketKey);
            } else {
              _whyOpen.add(b.bucketKey);
            }
          }),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  "Why these?",
                  style: Theme.of(context)
                      .textTheme
                      .labelMedium
                      ?.copyWith(color: scheme.primary, fontWeight: FontWeight.w500),
                ),
                Icon(open ? Icons.expand_less : Icons.expand_more,
                    size: 16, color: scheme.primary),
              ],
            ),
          ),
        ),
        if (open)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              (b.axis == "folder"
                      ? "These photos share a folder. We worked out a likely date for each from the clues we found."
                      : b.axis == "time"
                          ? "These photos were taken around the same time. We worked out a likely date for each from the clues we found."
                          : _why(b.evidenceSource)) +
                  (b.conflict
                      ? " The date saved with the file disagrees with this, which is why it's here to check."
                      : ""),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
      ],
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
    final busy = _busy.contains(b.bucketKey);
    final phrase = _phrase(b.evidenceSource);
    // Folder / time axes label the bucket by its group (path / span); the source
    // axis keeps the reason-led copy + the conflict-compare affordance.
    final title = b.axis != "source"
        ? b.reasonLabel
        : (b.conflict
            ? "The saved date looks wrong for these"
            : "These got their date from $phrase");
    final sub = b.axis != "source"
        ? (b.confidenceTier == "high" ? null : "Peek before you apply.")
        : (b.conflict
            ? "We think the right date comes from $phrase."
            : (b.confidenceTier == "high" ? null : "Peek before you apply."));
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
            const SizedBox(height: 6),
            _whyExpander(b),
            const SizedBox(height: 6),
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
                // M15.4 P1-1 — drop into one-by-one review (swipe / tap).
                TextButton.icon(
                  onPressed: busy
                      ? null
                      : () => setState(() =>
                          _reviewOpen = _reviewOpen == b.bucketKey ? null : b.bucketKey),
                  icon: Icon(
                    _reviewOpen == b.bucketKey
                        ? Icons.expand_less
                        : Icons.touch_app_outlined,
                    size: 18,
                  ),
                  label: Text(
                      _reviewOpen == b.bucketKey ? "Done reviewing" : "Review one by one"),
                ),
              ],
            ),
            if (_reviewOpen == b.bucketKey) _reviewItems(b),
          ],
        ),
      ),
    );
  }

  // M15.4 P1-1 — per-item review surface: each sample is a swipeable card
  // (swipe right = use the photo's date, left = keep the saved date) with
  // explicit buttons too (WCAG 2.5.1: never swipe-only). Visibility is driven
  // by `_itemHidden` (the Dismissible never removes its own child) so an
  // optimistic action can be undone via the snackbar.
  Widget _reviewItems(ReviewBucket b) {
    final items = b.sample.where((s) => !_itemHidden.contains(s.assetId)).toList();
    if (items.isEmpty) {
      return const Padding(
        padding: EdgeInsets.only(top: 12),
        child: Text("All caught up here — apply the rest above."),
      );
    }
    return Column(
      children: [
        const SizedBox(height: 8),
        for (final s in items) _reviewItemCard(s),
      ],
    );
  }

  Widget _reviewItemCard(ReviewBucketSample s) {
    final url = _thumbs[s.assetId];
    final busy = _itemBusy.contains(s.assetId);
    return Dismissible(
      key: ValueKey("rev-${s.assetId}"),
      background: Container(
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.only(left: 16),
        color: Colors.green.withValues(alpha: 0.85),
        child: const Icon(Icons.check, color: Colors.white),
      ),
      secondaryBackground: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 16),
        color: Colors.redAccent.withValues(alpha: 0.85),
        child: const Icon(Icons.history, color: Colors.white),
      ),
      confirmDismiss: (dir) async {
        await _applyItem(
          s,
          dir == DismissDirection.startToEnd ? "confirm" : "reject",
        );
        return false; // visibility handled by _itemHidden
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                width: 44,
                height: 44,
                child: url == null
                    ? imageSkeleton(context)
                    : CachedNetworkImage(
                        imageUrl: url, fit: BoxFit.cover, memCacheWidth: 120),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                "Photo says ${_fmtDate(s.mapEstimate, precision: s.mapPrecision)}",
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            IconButton(
              tooltip: "Use this date",
              onPressed: busy ? null : () => _applyItem(s, "confirm"),
              icon: const Icon(Icons.check_circle_outline),
            ),
            IconButton(
              tooltip: "Keep saved date",
              onPressed: busy ? null : () => _applyItem(s, "reject"),
              icon: const Icon(Icons.history),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _applyItem(ReviewBucketSample s, String action) async {
    if (_itemBusy.contains(s.assetId)) return;
    HapticFeedback.mediumImpact();
    setState(() {
      _itemBusy.add(s.assetId);
      _itemHidden.add(s.assetId);
    });
    try {
      await widget.client.confirmReviewItem(s.assetId, action);
      if (!mounted) return;
      setState(() => action == "confirm" ? _fixed++ : _kept++);
      final inverse = action == "confirm" ? "reject" : "confirm";
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(action == "confirm" ? "Date applied" : "Kept saved date"),
        duration: const Duration(seconds: 8),
        action: SnackBarAction(
          label: "Undo",
          onPressed: () async {
            try {
              await widget.client.confirmReviewItem(s.assetId, inverse);
            } catch (_) {}
            if (mounted) {
              setState(() {
                _itemHidden.remove(s.assetId);
                action == "confirm" ? _fixed-- : _kept--;
              });
            }
          },
        ),
      ));
    } catch (_) {
      if (mounted) setState(() => _itemHidden.remove(s.assetId));
    } finally {
      if (mounted) setState(() => _itemBusy.remove(s.assetId));
    }
  }
}
