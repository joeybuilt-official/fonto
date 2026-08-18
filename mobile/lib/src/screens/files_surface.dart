// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos-Files split — Files surface (mobile).
//
// Retrieval-oriented list (vs the Photos timeline): pinned search bar
// (server-side filename + OCR + source), recency bands ("This week" /
// "Earlier"), list rows (type icon + filename + snippet + imported date),
// imported-at DESC, and a Properties bottom sheet on tap. Mirrors the web
// LibraryFilesView. See plans/photos-vs-files-split/plan.md.

import "dart:async";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";

class FilesSurface extends StatefulWidget {
  const FilesSurface({
    super.key,
    required this.client,
    required this.kindParam,
    this.directoryPathPrefix,
  });

  final FontoClient client;
  final String? kindParam;
  final String? directoryPathPrefix;

  @override
  State<FilesSurface> createState() => _FilesSurfaceState();
}

class _FilesSurfaceState extends State<FilesSurface> {
  final _searchCtrl = TextEditingController();
  Timer? _debounce;
  String _query = "";
  List<Asset> _assets = const [];
  bool _loading = true;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(FilesSurface old) {
    super.didUpdateWidget(old);
    if (old.kindParam != widget.kindParam ||
        old.directoryPathPrefix != widget.directoryPathPrefix) {
      _load();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  /// Clear the search box from the empty state's CTA, so "No files match …"
  /// is recoverable without hunting for the × in the field.
  void _clearQuery() {
    _debounce?.cancel();
    _searchCtrl.clear();
    _query = "";
    _load();
  }

  void _onSearchChanged(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      if (_query == v.trim()) return;
      _query = v.trim();
      _load();
    });
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = false;
    });
    try {
      final page = await widget.client.listAssets(
        limit: 200,
        sort: "created",
        kind: widget.kindParam,
        q: _query.isEmpty ? null : _query,
        directoryPathPrefix: widget.directoryPathPrefix,
      );
      if (!mounted) return;
      setState(() {
        _assets = page.assets;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _assets = const [];
        _loading = false;
        _error = true;
      });
    }
  }

  IconData _kindIcon(String? kind) {
    switch (kind) {
      case "screenshot":
        return Icons.smartphone_outlined;
      case "graphics":
        return Icons.palette_outlined;
      case "document":
        return Icons.description_outlined;
      default:
        return Icons.insert_drive_file_outlined;
    }
  }

  String _fmtDate(DateTime d) {
    const m = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    return "${m[d.month - 1]} ${d.day}, ${d.year}";
  }

  String _fmtSize(int b) {
    if (b < 1024) return "$b B";
    if (b < 1024 * 1024) return "${(b / 1024).round()} KB";
    return "${(b / (1024 * 1024)).toStringAsFixed(1)} MB";
  }

  String _band(DateTime d) {
    final age = DateTime.now().difference(d);
    return age.inDays <= 7 ? "This week" : "Earlier";
  }

  String? _snippet(Asset a) {
    final t = (a.ocrText ?? a.description ?? "").trim().replaceAll(RegExp(r"\s+"), " ");
    if (t.isEmpty) return null;
    return t.length > 120 ? "${t.substring(0, 120)}…" : t;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        // Pinned search bar.
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: TextField(
            controller: _searchCtrl,
            onChanged: _onSearchChanged,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 20),
              suffixIcon: _searchCtrl.text.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      onPressed: () {
                        _searchCtrl.clear();
                        _onSearchChanged("");
                      },
                    ),
              hintText: "Search files — name, text, source…",
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(24),
              ),
              contentPadding: const EdgeInsets.symmetric(vertical: 4),
            ),
          ),
        ),
        Expanded(child: _buildList(theme)),
      ],
    );
  }

  Widget _buildList(ThemeData theme) {
    // Was a hand-rolled clone of the shared 4-state widgets (bare Text + a
    // TextButton, no icon, no tokens), which made this the one list surface
    // that looked different from the other twelve.
    if (_loading) {
      return const ListSkeleton();
    }
    if (_error) {
      return ListErrorState(
        message: "Couldn't load your files. Check your connection and retry.",
        onRetry: _load,
      );
    }
    if (_assets.isEmpty) {
      return ListEmptyState(
        icon: Icons.folder_open_outlined,
        message: _query.isEmpty ? "No files yet." : "No files match “$_query”.",
        filtered: _query.isNotEmpty,
        onClearFilters: _query.isEmpty ? null : _clearQuery,
      );
    }

    // Flatten into a lazy row model (assets already imported-at DESC from the
    // server). Each entry is either a recency-band header or an asset row; the
    // O(n) band scan runs once here, the widgets build on demand in the
    // ListView.builder below so we don't eagerly inflate ~200 rows.
    final rows = <_FileRow>[];
    String? lastBand;
    for (final a in _assets) {
      final b = _band(a.createdAt);
      if (b != lastBand) {
        lastBand = b;
        rows.add(_FileRow.header(b));
      }
      rows.add(_FileRow.asset(a));
    }
    return ListView.builder(
      itemCount: rows.length,
      itemBuilder: (context, i) {
        final row = rows[i];
        if (row.header != null) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Text(
              row.header!.toUpperCase(),
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.6,
              ),
            ),
          );
        }
        final a = row.asset!;
        final sub =
            _snippet(a) ?? "${a.kind ?? "file"} · ${_fmtSize(a.sizeBytes)}";
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: theme.colorScheme.surfaceContainerHighest,
            child: Icon(_kindIcon(a.kind),
                size: 20, color: theme.colorScheme.onSurfaceVariant),
          ),
          title: Text(a.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis),
          trailing: Text(
            _fmtDate(a.createdAt),
            style: theme.textTheme.labelSmall
                ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
          onTap: () => _openProperties(a),
        );
      },
    );
  }

  Future<void> _openProperties(Asset a) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => _FileProperties(client: widget.client, asset: a),
    );
  }
}

class _FileProperties extends StatefulWidget {
  const _FileProperties({required this.client, required this.asset});
  final FontoClient client;
  final Asset asset;

  @override
  State<_FileProperties> createState() => _FilePropertiesState();
}

class _FilePropertiesState extends State<_FileProperties> {
  Asset? _full;
  String? _previewUrl;

  @override
  void initState() {
    super.initState();
    _hydrate();
  }

  Future<void> _hydrate() async {
    try {
      final urls =
          await widget.client.assetUrls([widget.asset.id], variant: "thumb");
      if (mounted) setState(() => _previewUrl = urls[widget.asset.id]);
    } catch (_) {}
    try {
      final full = await widget.client.getAsset(widget.asset.id);
      if (mounted) setState(() => _full = full);
    } catch (_) {}
  }

  String _fmtDate(DateTime d) {
    const m = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    return "${m[d.month - 1]} ${d.day}, ${d.year}";
  }

  String _fmtSize(int b) {
    if (b < 1024) return "$b B";
    if (b < 1024 * 1024) return "${(b / 1024).round()} KB";
    return "${(b / (1024 * 1024)).toStringAsFixed(1)} MB";
  }

  @override
  Widget build(BuildContext context) {
    final a = _full ?? widget.asset;
    final theme = Theme.of(context);
    final ocr = (a.ocrText ?? "").trim();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(a.filename,
                  style: theme.textTheme.titleMedium,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis),
              const SizedBox(height: 12),
              if (a.mimeType.startsWith("image/") && _previewUrl != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.network(
                    _previewUrl!,
                    fit: BoxFit.contain,
                    height: 200,
                    width: double.infinity,
                    errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                  ),
                ),
              const SizedBox(height: 12),
              _row(theme, "Type", a.kind ?? "—"),
              _row(theme, "Format", a.mimeType),
              _row(theme, "Size", _fmtSize(a.sizeBytes)),
              _row(theme, "Imported", _fmtDate(a.createdAt)),
              if (a.capturedAt != null)
                _row(theme, "Captured", _fmtDate(a.capturedAt!)),
              if (a.source != null && a.source!.isNotEmpty)
                _row(theme, "Source", a.source!),
              if (ocr.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text("Extracted text",
                    style: theme.textTheme.labelLarge
                        ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                Container(
                  constraints: const BoxConstraints(maxHeight: 160),
                  width: double.infinity,
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: SingleChildScrollView(
                    child: Text(ocr, style: theme.textTheme.bodySmall),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _row(ThemeData theme, String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 96,
              child: Text(label,
                  style: theme.textTheme.labelMedium
                      ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
            ),
            Expanded(
              child: Text(value,
                  style: theme.textTheme.bodyMedium,
                  textAlign: TextAlign.right),
            ),
          ],
        ),
      );
}

/// One row in the lazy Files list — either a recency-band [header] or an
/// [asset] row. Lets the file list render through ListView.builder instead of
/// eagerly inflating every row.
class _FileRow {
  const _FileRow.header(this.header) : asset = null;
  const _FileRow.asset(this.asset) : header = null;

  final String? header;
  final Asset? asset;
}
