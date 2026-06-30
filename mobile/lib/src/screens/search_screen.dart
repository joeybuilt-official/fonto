// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Search — feature parity with the web search page. Plain text search hits
// /api/v1/search (filename, description, OCR, classification/date/color/tag
// filters, OCR-only + semantic re-rank toggles). For "natural" queries it also
// fires /api/v1/search/clip in parallel and renders a separate "Semantic
// matches" section, exactly like the web. No pagination today (the endpoints
// don't expose a cursor) — capped at whatever the server returns in one shot.

import "package:cached_network_image/cached_network_image.dart";
import "package:connectivity_plus/connectivity_plus.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";
import "asset_detail_screen.dart";

// Classification chips — mirror SUBTYPE_CHIPS in the web FilterPopover.
const _subtypeChips = <(String, String)>[
  ("photo", "Photos"),
  ("screenshot", "Screenshots"),
  ("mockup", "Mockups"),
  ("logo", "Logos"),
  ("icon", "Icons"),
  ("scan", "Scans"),
  ("document", "Documents"),
];

// Color chips — mirror COLOR_CHIPS in the web FilterPopover. The query carries
// the chip *name* (e.g. "red"); hex is display-only.
const _colorChips = <(String, int)>[
  ("red", 0xFFEF4444),
  ("orange", 0xFFF97316),
  ("yellow", 0xFFEAB308),
  ("green", 0xFF22C55E),
  ("teal", 0xFF14B8A6),
  ("blue", 0xFF3B82F6),
  ("purple", 0xFFA855F7),
  ("pink", 0xFFEC4899),
  ("brown", 0xFF92400E),
  ("gray", 0xFF6B7280),
  ("black", 0xFF0A0A0A),
  ("white", 0xFFFAFAFA),
];

// Heuristic for "fire a CLIP search alongside the text search". Mirrors
// looksSemantic() on the web: >3 words, or contains a visual verb. False
// positives just produce an extra (possibly empty) section.
const _semanticVerbs = <String>[
  "show", "find", "with", "wearing", "holding", "near", "looking", "of",
  "containing", "featuring", "during", "at",
];

bool _looksSemantic(String query) {
  final trimmed = query.trim();
  if (trimmed.isEmpty) return false;
  final words = trimmed.split(RegExp(r"\s+")).where((w) => w.isNotEmpty);
  if (words.length > 3) return true;
  final lower = trimmed.toLowerCase();
  return _semanticVerbs.any((v) => lower.contains(" $v ") || lower.startsWith("$v "));
}

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _ctrl = TextEditingController();
  bool _busy = false;
  // Monotonic id for the in-flight search. Concurrent _run() calls (chip
  // toggles, repeated submit, filter-apply) can resolve out of order; only the
  // newest seq is allowed to commit results, so stale responses can't clobber
  // fresh ones and flash assets in/out.
  int _searchSeq = 0;
  String? _error;
  // Search results aren't cached (the endpoint has no clean offline shape), so
  // when a query fails offline we show a dedicated "needs connection" state
  // rather than a generic error.
  bool _offline = false;

  List<Asset> _results = const [];
  List<Asset> _semanticResults = const [];
  bool _semanticUnavailable = false;
  Map<String, String> _thumbs = const {};

  // Filter state — mirrors the web search toolbar.
  bool _semantic = false;
  bool _ocrOnly = false;
  String? _classification;
  String? _color;
  String? _tagId;
  String? _tagName;
  DateTime? _from;
  DateTime? _to;
  // EXIF facets — mirror the web search FilterPopover "Camera" section.
  String? _cameraMake;
  String? _cameraModel;
  String? _lensModel;
  String? _iso;
  String? _fNumber;
  String? _focalLength;

  List<String?> get _exifValues =>
      [_cameraMake, _cameraModel, _lensModel, _iso, _fNumber, _focalLength];

  bool get _hasFilters =>
      _classification != null ||
      _color != null ||
      _tagId != null ||
      _from != null ||
      _to != null ||
      _exifValues.any((v) => v != null);

  int get _filterCount => [
        _classification,
        _color,
        _tagId,
        _from,
        _to,
        ..._exifValues,
      ].where((v) => v != null).length;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    final seq = ++_searchSeq;
    final q = _ctrl.text.trim();
    // Match the web: nothing to do when there's no query and no active filter.
    if (q.isEmpty && !_ocrOnly && !_hasFilters) {
      setState(() {
        _results = const [];
        _semanticResults = const [];
        _semanticUnavailable = false;
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
      // Fire CLIP alongside text search for "natural" queries, but skip it when
      // structured filters narrow the view (mirrors the web's !tid && !cl && !col).
      final runClip = q.isNotEmpty &&
          _looksSemantic(q) &&
          _tagId == null &&
          _classification == null &&
          _color == null &&
          _exifValues.every((v) => v == null);
      final clipFuture =
          runClip ? widget.client.searchClip(q) : Future.value(<Asset>[]);

      final assets = await widget.client.search(
        q,
        classification: _classification,
        tagId: _tagId,
        color: _color,
        dateFrom: _from == null ? null : _fmtDate(_from!),
        dateTo: _to == null ? null : _fmtDate(_to!),
        cameraMake: _cameraMake,
        cameraModel: _cameraModel,
        lensModel: _lensModel,
        iso: _iso,
        fNumber: _fNumber,
        focalLength: _focalLength,
        semantic: _semantic,
        ocrOnly: _ocrOnly,
      );
      final clipRaw = await clipFuture;
      // Drop semantic hits already in the text results: the same asset in both
      // grids means two Hero widgets sharing one tag, which Flutter rejects and
      // renders as flicker. Dedup keeps every Hero tag unique on screen.
      final textIds = assets.map((a) => a.id).toSet();
      final clip = clipRaw.where((a) => !textIds.contains(a.id)).toList();

      // Resolve thumbs for the union of both result sets in one call.
      final ids = <String>{
        ...textIds,
        ...clip.map((a) => a.id),
      }.toList();
      final thumbs = ids.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(ids, variant: "thumb");
      // Stale-response guard: a newer _run() superseded this one — discard.
      if (!mounted || seq != _searchSeq) return;
      setState(() {
        _results = assets;
        _semanticResults = clip;
        _semanticUnavailable = runClip && clip.isEmpty;
        _thumbs = thumbs;
        _busy = false;
      });
    } on ApiException catch (e) {
      if (seq == _searchSeq) await _fail("${e.status}: ${e.message}");
    } catch (e) {
      if (seq == _searchSeq) await _fail(e.toString());
    }
  }

  static String _fmtDate(DateTime d) =>
      "${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}";

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

  Future<void> _openFilters() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => _FilterSheet(
        client: widget.client,
        classification: _classification,
        color: _color,
        tagId: _tagId,
        tagName: _tagName,
        from: _from,
        to: _to,
        cameraMake: _cameraMake,
        cameraModel: _cameraModel,
        lensModel: _lensModel,
        iso: _iso,
        fNumber: _fNumber,
        focalLength: _focalLength,
        onApply: (s) {
          setState(() {
            _classification = s.classification;
            _color = s.color;
            _tagId = s.tagId;
            _tagName = s.tagName;
            _from = s.from;
            _to = s.to;
            _cameraMake = s.cameraMake;
            _cameraModel = s.cameraModel;
            _lensModel = s.lensModel;
            _iso = s.iso;
            _fNumber = s.fNumber;
            _focalLength = s.focalLength;
          });
          _run();
        },
      ),
    );
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
            hintText: "Search photos, text, descriptions…",
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.search),
            onPressed: _busy ? null : _run,
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: _toggleBar(),
        ),
      ),
      body: _buildBody(),
    );
  }

  Widget _toggleBar() {
    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilterChip(
              label: const Text("Semantic"),
              avatar: const Icon(Icons.auto_awesome, size: 18),
              selected: _semantic,
              onSelected: (v) {
                setState(() => _semantic = v);
                _run();
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilterChip(
              label: const Text("OCR only"),
              avatar: const Icon(Icons.text_fields, size: 18),
              selected: _ocrOnly,
              onSelected: (v) {
                setState(() => _ocrOnly = v);
                _run();
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: ActionChip(
              avatar: const Icon(Icons.tune, size: 18),
              label: Text(_filterCount > 0 ? "Filters ($_filterCount)" : "Filters"),
              onPressed: _openFilters,
            ),
          ),
          if (_hasFilters)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ActionChip(
                avatar: const Icon(Icons.clear, size: 18),
                label: const Text("Clear"),
                onPressed: () {
                  setState(() {
                    _classification = null;
                    _color = null;
                    _tagId = null;
                    _tagName = null;
                    _from = null;
                    _to = null;
                    _cameraMake = null;
                    _cameraModel = null;
                    _lensModel = null;
                    _iso = null;
                    _fNumber = null;
                    _focalLength = null;
                  });
                  _run();
                },
              ),
            ),
        ],
      ),
    );
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
        _results = _results.where((a) => a.id != trashedId).toList();
        _semanticResults =
            _semanticResults.where((a) => a.id != trashedId).toList();
      });
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
    final hasInput = _ctrl.text.trim().isNotEmpty || _ocrOnly || _hasFilters;
    if (_results.isEmpty && _semanticResults.isEmpty) {
      return ListEmptyState(
        icon: Icons.search,
        message: hasInput
            ? "No assets found."
            : "Type to search your photos, text, and descriptions — or set a filter.",
      );
    }
    return CustomScrollView(
      slivers: [
        if (_results.isNotEmpty) ...[
          _sectionHeader(
            _semanticResults.isNotEmpty || _semanticUnavailable
                ? "Matches"
                : null,
          ),
          _grid(_results),
        ],
        if (_semanticUnavailable)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                "Semantic search unavailable.",
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),
        if (_semanticResults.isNotEmpty) ...[
          _sectionHeader("Semantic matches"),
          _grid(_semanticResults),
        ],
      ],
    );
  }

  Widget _sectionHeader(String? label) {
    if (label == null) return const SliverToBoxAdapter(child: SizedBox.shrink());
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
        child: Row(
          children: [
            const Icon(Icons.auto_awesome, size: 16),
            const SizedBox(width: 6),
            Text(label, style: Theme.of(context).textTheme.titleSmall),
          ],
        ),
      ),
    );
  }

  Widget _grid(List<Asset> set) {
    return SliverPadding(
      padding: const EdgeInsets.all(4),
      sliver: SliverGrid(
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 4,
          mainAxisSpacing: 4,
        ),
        delegate: SliverChildBuilderDelegate(
          (context, i) {
            final a = set[i];
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
              onTap: () => _openDetail(set, i),
              child: tile,
            );
          },
          childCount: set.length,
        ),
      ),
    );
  }
}

class _FilterValues {
  const _FilterValues({
    this.classification,
    this.color,
    this.tagId,
    this.tagName,
    this.from,
    this.to,
    this.cameraMake,
    this.cameraModel,
    this.lensModel,
    this.iso,
    this.fNumber,
    this.focalLength,
  });
  final String? classification;
  final String? color;
  final String? tagId;
  final String? tagName;
  final DateTime? from;
  final DateTime? to;
  final String? cameraMake;
  final String? cameraModel;
  final String? lensModel;
  final String? iso;
  final String? fNumber;
  final String? focalLength;
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet({
    required this.client,
    required this.onApply,
    this.classification,
    this.color,
    this.tagId,
    this.tagName,
    this.from,
    this.to,
    this.cameraMake,
    this.cameraModel,
    this.lensModel,
    this.iso,
    this.fNumber,
    this.focalLength,
  });

  final FontoClient client;
  final void Function(_FilterValues) onApply;
  final String? classification;
  final String? color;
  final String? tagId;
  final String? tagName;
  final DateTime? from;
  final DateTime? to;
  final String? cameraMake;
  final String? cameraModel;
  final String? lensModel;
  final String? iso;
  final String? fNumber;
  final String? focalLength;

  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  String? _classification;
  String? _color;
  String? _tagId;
  String? _tagName;
  DateTime? _from;
  DateTime? _to;
  List<TopTag> _tags = const [];
  late final TextEditingController _cameraMake;
  late final TextEditingController _cameraModel;
  late final TextEditingController _lensModel;
  late final TextEditingController _iso;
  late final TextEditingController _fNumber;
  late final TextEditingController _focalLength;

  @override
  void initState() {
    super.initState();
    _classification = widget.classification;
    _color = widget.color;
    _tagId = widget.tagId;
    _tagName = widget.tagName;
    _from = widget.from;
    _to = widget.to;
    _cameraMake = TextEditingController(text: widget.cameraMake ?? "");
    _cameraModel = TextEditingController(text: widget.cameraModel ?? "");
    _lensModel = TextEditingController(text: widget.lensModel ?? "");
    _iso = TextEditingController(text: widget.iso ?? "");
    _fNumber = TextEditingController(text: widget.fNumber ?? "");
    _focalLength = TextEditingController(text: widget.focalLength ?? "");
    widget.client.topTags(limit: 60).then((t) {
      if (mounted) setState(() => _tags = t);
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _cameraMake.dispose();
    _cameraModel.dispose();
    _lensModel.dispose();
    _iso.dispose();
    _fNumber.dispose();
    _focalLength.dispose();
    super.dispose();
  }

  String? _nullIfEmpty(TextEditingController c) {
    final v = c.text.trim();
    return v.isEmpty ? null : v;
  }

  Future<void> _pickDate(bool isFrom) async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: (isFrom ? _from : _to) ?? now,
      firstDate: DateTime(1970),
      lastDate: DateTime(now.year + 1),
    );
    if (picked == null) return;
    setState(() {
      if (isFrom) {
        _from = picked;
      } else {
        _to = picked;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text("Type", style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: _subtypeChips.map((c) {
                return ChoiceChip(
                  label: Text(c.$2),
                  selected: _classification == c.$1,
                  onSelected: (sel) =>
                      setState(() => _classification = sel ? c.$1 : null),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            Text("Color", style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _colorChips.map((c) {
                final selected = _color == c.$1;
                return GestureDetector(
                  onTap: () => setState(() => _color = selected ? null : c.$1),
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: Color(c.$2),
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected
                            ? Theme.of(context).colorScheme.primary
                            : Theme.of(context).dividerColor,
                        width: selected ? 3 : 1,
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            Text("Date range", style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => _pickDate(true),
                    child: Text(_from == null
                        ? "From"
                        : _SearchScreenState._fmtDate(_from!)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => _pickDate(false),
                    child: Text(_to == null
                        ? "To"
                        : _SearchScreenState._fmtDate(_to!)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Text("Tag", style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            if (_tags.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 4),
                child: Text("No tags yet."),
              )
            else
              Wrap(
                spacing: 8,
                children: _tags.map((t) {
                  return ChoiceChip(
                    label: Text(t.name),
                    selected: _tagId == t.id,
                    onSelected: (sel) => setState(() {
                      _tagId = sel ? t.id : null;
                      _tagName = sel ? t.name : null;
                    }),
                  );
                }).toList(),
              ),
            const SizedBox(height: 16),
            Text("Camera", style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            TextField(
              controller: _cameraMake,
              decoration: const InputDecoration(
                isDense: true,
                border: OutlineInputBorder(),
                hintText: "Camera make (e.g. Canon)",
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _cameraModel,
              decoration: const InputDecoration(
                isDense: true,
                border: OutlineInputBorder(),
                hintText: "Camera model",
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _lensModel,
              decoration: const InputDecoration(
                isDense: true,
                border: OutlineInputBorder(),
                hintText: "Lens model",
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _iso,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      isDense: true,
                      border: OutlineInputBorder(),
                      hintText: "ISO",
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _fNumber,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      isDense: true,
                      border: OutlineInputBorder(),
                      hintText: "ƒ",
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _focalLength,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      isDense: true,
                      border: OutlineInputBorder(),
                      hintText: "mm",
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                TextButton(
                  onPressed: () {
                    setState(() {
                      _classification = null;
                      _color = null;
                      _tagId = null;
                      _tagName = null;
                      _from = null;
                      _to = null;
                      _cameraMake.clear();
                      _cameraModel.clear();
                      _lensModel.clear();
                      _iso.clear();
                      _fNumber.clear();
                      _focalLength.clear();
                    });
                  },
                  child: const Text("Reset"),
                ),
                const Spacer(),
                FilledButton(
                  onPressed: () {
                    widget.onApply(_FilterValues(
                      classification: _classification,
                      color: _color,
                      tagId: _tagId,
                      tagName: _tagName,
                      from: _from,
                      to: _to,
                      cameraMake: _nullIfEmpty(_cameraMake),
                      cameraModel: _nullIfEmpty(_cameraModel),
                      lensModel: _nullIfEmpty(_lensModel),
                      iso: _nullIfEmpty(_iso),
                      fNumber: _nullIfEmpty(_fNumber),
                      focalLength: _nullIfEmpty(_focalLength),
                    ));
                    Navigator.of(context).pop();
                  },
                  child: const Text("Apply"),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
