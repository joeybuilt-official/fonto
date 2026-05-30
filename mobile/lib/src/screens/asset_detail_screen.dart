// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Full-screen asset viewer. PageView between assets (left/right swipe),
// PhotoView per page (pinch + pan + double-tap zoom). AppBar actions:
// favorite toggle, trash, native share. Preview-variant URLs fetched
// lazily as the user scrolls — keeps the initial route push cheap.

import "dart:math" show min, max;

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";
import "package:photo_view/photo_view.dart";
import "package:photo_view/photo_view_gallery.dart";
import "package:share_plus/share_plus.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";

class AssetDetailScreen extends StatefulWidget {
  const AssetDetailScreen({
    super.key,
    required this.client,
    required this.assets,
    required this.initialIndex,
  });

  final FontoClient client;
  final List<Asset> assets;
  final int initialIndex;

  @override
  State<AssetDetailScreen> createState() => _AssetDetailScreenState();
}

class _AssetDetailScreenState extends State<AssetDetailScreen> {
  late final PageController _page =
      PageController(initialPage: widget.initialIndex);
  late final List<Asset> _assets = List.of(widget.assets);
  late int _index = widget.initialIndex;
  final Map<String, String> _previews = {};
  // Phase 6.12 — extracted text layer for text/code assets, fetched lazily
  // from the per-asset detail endpoint as the user scrolls onto one.
  final Map<String, String> _texts = {};
  bool _acting = false;

  static bool _isText(Asset a) => a.mimeType.startsWith("text/");

  Asset get _cur => _assets[_index];

  @override
  void initState() {
    super.initState();
    _ensurePreviews(_index);
    _ensureText(_index);
  }

  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  /// Fetch preview URLs for a window of ±3 around `i` in one batch.
  /// Cheap b/c assetUrls is batched server-side; skips ids already cached.
  Future<void> _ensurePreviews(int i) async {
    final lo = (i - 3).clamp(0, _assets.length - 1);
    final hi = (i + 3).clamp(0, _assets.length - 1);
    final ids = <String>[];
    for (var k = lo; k <= hi; k++) {
      final id = _assets[k].id;
      if (!_previews.containsKey(id)) ids.add(id);
    }
    if (ids.isEmpty) return;
    try {
      final batch = await widget.client.assetUrls(ids, variant: "preview");
      if (!mounted) return;
      setState(() => _previews.addAll(batch));
    } catch (_) {
      // Silent — placeholder will render. Asset is still usable via thumb.
    }
  }

  void _onPageChanged(int i) {
    setState(() => _index = i);
    _ensurePreviews(i);
    _ensureText(i);
  }

  /// Fetch the text layer for a text/code asset on demand. No-op for media
  /// assets or ids already cached.
  Future<void> _ensureText(int i) async {
    final a = _assets[i];
    if (!_isText(a) || _texts.containsKey(a.id)) return;
    try {
      final full = await widget.client.getAsset(a.id);
      if (!mounted) return;
      setState(() => _texts[a.id] = full.ocrText ?? "");
    } catch (_) {
      if (!mounted) return;
      setState(() => _texts[a.id] = "");
    }
  }

  Future<void> _toggleFavorite() async {
    if (_acting) return;
    setState(() => _acting = true);
    final next = !(_cur.isFavorite ?? false);
    try {
      final updated = await widget.client.setFavorite(_cur.id, next);
      if (!mounted) return;
      setState(() => _assets[_index] = updated);
    } on ApiException catch (e) {
      _snack("Favorite failed: ${e.status} ${e.message}");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _reprocess() async {
    if (_acting) return;
    setState(() => _acting = true);
    try {
      await widget.client.reprocessAsset(_cur.id);
      if (!mounted) return;
      _snack("Re-scan queued — recognition will refresh shortly.");
    } on ApiException catch (e) {
      _snack("Re-scan failed: ${e.status} ${e.message}");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _confirmTrash() async {
    if (_acting) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Move to trash?"),
        content: Text('"${_cur.filename}" will be moved to trash.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text("Cancel"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text("Move to trash"),
          ),
        ],
      ),
    );
    if (ok == true) await _trash();
  }

  Future<void> _trash() async {
    if (_acting) return;
    setState(() => _acting = true);
    try {
      await widget.client.trashAsset(_cur.id);
      if (!mounted) return;
      // Pop with the trashed id so the caller can drop it from the grid.
      Navigator.of(context).pop(<String, dynamic>{
        "trashedId": _cur.id,
      });
    } on ApiException catch (e) {
      _snack("Trash failed: ${e.status} ${e.message}");
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _share() async {
    if (_acting) return;
    setState(() => _acting = true);
    try {
      final url = await widget.client.createAssetShare(_cur.id);
      if (!mounted) return;
      await Share.share(url, subject: _cur.filename);
    } on ApiException catch (e) {
      _snack("Share failed: ${e.status} ${e.message}");
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  void _showFaceTagger() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => _FaceTaggingScreen(
        client: widget.client,
        asset: _cur,
        imageUrl: _previews[_cur.id],
      ),
    ));
  }

  String _fmtSize(int bytes) {
    if (bytes <= 0) return "—";
    if (bytes < 1024) return "$bytes B";
    if (bytes < 1024 * 1024) return "${(bytes / 1024).toStringAsFixed(0)} KB";
    if (bytes < 1024 * 1024 * 1024) {
      return "${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB";
    }
    return "${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB";
  }

  String _fmtDate(DateTime? d) {
    if (d == null) return "—";
    final l = d.toLocal();
    String two(int n) => n.toString().padLeft(2, "0");
    return "${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}";
  }

  void _showInfo() {
    final a = _cur;
    final rows = <(String, String)>[
      ("Filename", a.filename),
      ("Type", a.mimeType),
      ("Size", _fmtSize(a.sizeBytes)),
      if (a.classification != null && a.classification!.isNotEmpty)
        ("Category", a.classification!),
      if (a.directoryPath != null && a.directoryPath!.isNotEmpty)
        ("Folder", a.directoryPath!),
      if (a.capturedAt != null) ("Captured", _fmtDate(a.capturedAt)),
      if (a.rating != null && a.rating! > 0) ("Rating", "${a.rating} ★"),
      if (a.description != null && a.description!.isNotEmpty)
        ("Description", a.description!),
    ];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                "Details",
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 12),
              ...rows.map(
                (r) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 96,
                        child: Text(
                          r.$1,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.outline,
                            fontSize: 13,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(r.$2, style: const TextStyle(fontSize: 13)),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          _cur.filename,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 14),
        ),
        actions: [
          if (_cur.mimeType.startsWith("image/"))
            IconButton(
              tooltip: "Tag people",
              icon: const Icon(Icons.face_outlined),
              onPressed: () => _showFaceTagger(),
            ),
          IconButton(
            tooltip: "Info",
            icon: const Icon(Icons.info_outline),
            onPressed: _showInfo,
          ),
          IconButton(
            tooltip: (_cur.isFavorite ?? false) ? "Unfavorite" : "Favorite",
            icon: Icon(
              (_cur.isFavorite ?? false) ? Icons.star : Icons.star_border,
            ),
            onPressed: _acting ? null : _toggleFavorite,
          ),
          IconButton(
            tooltip: "Re-scan (AI)",
            icon: const Icon(Icons.auto_awesome_outlined),
            onPressed: _acting ? null : _reprocess,
          ),
          IconButton(
            tooltip: "Share",
            icon: const Icon(Icons.ios_share),
            onPressed: _acting ? null : _share,
          ),
          IconButton(
            tooltip: "Trash",
            icon: const Icon(Icons.delete_outline),
            onPressed: _acting ? null : _confirmTrash,
          ),
        ],
      ),
      body: PhotoViewGallery.builder(
        pageController: _page,
        itemCount: _assets.length,
        onPageChanged: _onPageChanged,
        backgroundDecoration: const BoxDecoration(color: Colors.black),
        loadingBuilder: (_, __) =>
            const Center(child: CircularProgressIndicator()),
        builder: (context, i) {
          final a = _assets[i];
          if (_isText(a)) {
            return PhotoViewGalleryPageOptions.customChild(
              disableGestures: true,
              child: _TextPage(
                text: _texts[a.id],
                code: a.mimeType != "text/plain",
              ),
            );
          }
          final url = _previews[a.id];
          return PhotoViewGalleryPageOptions.customChild(
            child: url == null
                ? const Center(child: CircularProgressIndicator())
                : CachedNetworkImage(
                    imageUrl: url,
                    fit: BoxFit.contain,
                    clearMemoryCacheWhenDispose: true,
                    memCacheWidth: 1920,
                    placeholder: (_, __) => const Center(
                      child: CircularProgressIndicator(),
                    ),
                    errorWidget: (_, __, ___) => const Icon(
                      Icons.broken_image,
                      color: Colors.white,
                      size: 48,
                    ),
                  ),
            minScale: PhotoViewComputedScale.contained,
            maxScale: PhotoViewComputedScale.covered * 4,
            heroAttributes: PhotoViewHeroAttributes(tag: a.id),
          );
        },
      ),
    );
  }
}

// Phase 6.12 — scrollable monospace renderer for text/code assets. `text` is
// null while the detail fetch is in flight, "" when there's no content.
class _TextPage extends StatelessWidget {
  const _TextPage({required this.text, required this.code});

  final String? text;
  final bool code;

  @override
  Widget build(BuildContext context) {
    if (text == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (text!.isEmpty) {
      return const Center(
        child: Text(
          "No text content extracted",
          style: TextStyle(color: Colors.white54),
        ),
      );
    }
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: SelectableText(
          text!,
          style: TextStyle(
            color: Colors.white,
            fontFamily: "monospace",
            fontSize: code ? 13 : 14,
            height: code ? 1.35 : 1.5,
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Face tagging — static image overlay with tappable face circles.
// ---------------------------------------------------------------------------

class _FaceTaggingScreen extends StatefulWidget {
  const _FaceTaggingScreen({
    required this.client,
    required this.asset,
    this.imageUrl,
  });

  final FontoClient client;
  final Asset asset;
  final String? imageUrl;

  @override
  State<_FaceTaggingScreen> createState() => _FaceTaggingScreenState();
}

class _FaceTaggingScreenState extends State<_FaceTaggingScreen> {
  bool _loading = true;
  String? _error;
  List<AssetFace> _faces = const [];
  List<Person> _persons = const [];
  String? _resolvedUrl;
  // Actual pixel dimensions of the image — from asset or resolved from ImageInfo.
  Size? _imageDims;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final facesFuture = widget.client.assetFaces(widget.asset.id);
      final personsFuture = widget.client.listPersons();
      final faces = await facesFuture;
      final persons = await personsFuture;
      String? url = widget.imageUrl;
      if (url == null) {
        final urlMap = await widget.client
            .assetUrls([widget.asset.id], variant: "preview");
        url = urlMap[widget.asset.id];
      }
      if (!mounted) return;
      final wPx = widget.asset.widthPx;
      final hPx = widget.asset.heightPx;
      setState(() {
        _faces = faces;
        _persons = persons;
        _resolvedUrl = url;
        if (wPx != null && hPx != null) {
          _imageDims = Size(wPx.toDouble(), hPx.toDouble());
        }
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

  void _onFaceTapped(AssetFace face) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _FaceTaggingSheet(
        face: face,
        persons: _persons,
        client: widget.client,
        onUpdated: (updated) {
          setState(() {
            final idx = _faces.indexWhere((f) => f.id == updated.id);
            if (idx >= 0) _faces[idx] = updated;
          });
        },
        onPersonCreated: (p) {
          setState(() => _persons = [p, ..._persons]);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text("Tag people"),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.error_outline, size: 40, color: Colors.white54),
                        const SizedBox(height: 12),
                        Text(_error!, style: const TextStyle(color: Colors.white70)),
                        const SizedBox(height: 16),
                        FilledButton(onPressed: _load, child: const Text("Retry")),
                      ],
                    ),
                  ),
                )
              : _resolvedUrl == null
                  ? const Center(
                      child: Text(
                        "Image not available",
                        style: TextStyle(color: Colors.white54),
                      ),
                    )
                  : _FaceImageOverlay(
                      imageUrl: _resolvedUrl!,
                      faces: _faces,
                      imageDims: _imageDims,
                      onDimsResolved: (size) {
                        if (_imageDims == null) {
                          setState(() => _imageDims = size);
                        }
                      },
                      onFaceTapped: _onFaceTapped,
                    ),
    );
  }
}

class _FaceImageOverlay extends StatelessWidget {
  const _FaceImageOverlay({
    required this.imageUrl,
    required this.faces,
    required this.imageDims,
    required this.onDimsResolved,
    required this.onFaceTapped,
  });

  final String imageUrl;
  final List<AssetFace> faces;
  final Size? imageDims;
  final void Function(Size) onDimsResolved;
  final void Function(AssetFace) onFaceTapped;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (ctx, constraints) {
      final ww = constraints.maxWidth;
      final wh = constraints.maxHeight;
      return Stack(
        fit: StackFit.expand,
        children: [
          CachedNetworkImage(
            imageUrl: imageUrl,
            fit: BoxFit.contain,
            imageBuilder: (ctx, imageProvider) {
              imageProvider.resolve(ImageConfiguration.empty).addListener(
                ImageStreamListener((info, _) {
                  onDimsResolved(Size(
                    info.image.width.toDouble(),
                    info.image.height.toDouble(),
                  ));
                }),
              );
              return Image(image: imageProvider, fit: BoxFit.contain);
            },
            placeholder: (_, __) =>
                const Center(child: CircularProgressIndicator()),
            errorWidget: (_, __, ___) =>
                const Icon(Icons.broken_image, color: Colors.white54, size: 48),
          ),
          if (imageDims != null)
            ..._buildFaceOverlays(ww, wh, imageDims!),
        ],
      );
    });
  }

  List<Widget> _buildFaceOverlays(double ww, double wh, Size dims) {
    final s = min(ww / dims.width, wh / dims.height);
    final rx = (ww - dims.width * s) / 2;
    final ry = (wh - dims.height * s) / 2;
    return faces.map((face) {
      final b = face.bbox;
      final left = rx + b.x * dims.width * s;
      final top = ry + b.y * dims.height * s;
      final fw = b.w * dims.width * s;
      final fh = b.h * dims.height * s;
      final d = max(fw, fh) + 12;
      final cx = left + fw / 2;
      final cy = top + fh / 2;
      return Positioned(
        left: cx - d / 2,
        top: cy - d / 2,
        width: d,
        height: d,
        child: GestureDetector(
          onTap: () => onFaceTapped(face),
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: face.personId != null
                    ? Colors.lightBlueAccent
                    : Colors.white70,
                width: 2,
              ),
            ),
            child: face.personName != null
                ? Align(
                    alignment: Alignment.bottomCenter,
                    child: FractionalTranslation(
                      translation: const Offset(0, 1),
                      child: Container(
                        padding:
                            const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                        decoration: BoxDecoration(
                          color: Colors.black54,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          face.personName!,
                          style: const TextStyle(
                              color: Colors.white, fontSize: 10),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                  )
                : null,
          ),
        ),
      );
    }).toList();
  }
}

class _FaceTaggingSheet extends StatefulWidget {
  const _FaceTaggingSheet({
    required this.face,
    required this.persons,
    required this.client,
    required this.onUpdated,
    required this.onPersonCreated,
  });

  final AssetFace face;
  final List<Person> persons;
  final FontoClient client;
  final void Function(AssetFace) onUpdated;
  final void Function(Person) onPersonCreated;

  @override
  State<_FaceTaggingSheet> createState() => _FaceTaggingSheetState();
}

class _FaceTaggingSheetState extends State<_FaceTaggingSheet> {
  final _ctrl = TextEditingController();
  bool _saving = false;
  String? _saveError;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  List<Person> get _filtered {
    final q = _ctrl.text.toLowerCase().trim();
    if (q.isEmpty) return widget.persons;
    return widget.persons
        .where((p) => (p.name ?? "").toLowerCase().contains(q))
        .toList();
  }

  Future<void> _assignTo(Person person) async {
    setState(() {
      _saving = true;
      _saveError = null;
    });
    final nav = Navigator.of(context);
    try {
      await widget.client.assignFace(widget.face.id, person.id);
      if (!mounted) return;
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
        personId: person.id,
        personName: person.name,
      ));
      nav.pop();
    } catch (e) {
      if (mounted) setState(() { _saving = false; _saveError = e.toString(); });
    }
  }

  Future<void> _createAndAssign() async {
    final name = _ctrl.text.trim();
    if (name.isEmpty) return;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    final nav = Navigator.of(context);
    try {
      final person = await widget.client.createPerson(name: name);
      if (!mounted) return;
      widget.onPersonCreated(person);
      await widget.client.assignFace(widget.face.id, person.id);
      if (!mounted) return;
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
        personId: person.id,
        personName: person.name,
      ));
      nav.pop();
    } catch (e) {
      if (mounted) setState(() { _saving = false; _saveError = e.toString(); });
    }
  }

  Future<void> _clearAssignment() async {
    setState(() { _saving = true; _saveError = null; });
    final nav = Navigator.of(context);
    try {
      await widget.client.assignFace(widget.face.id, null);
      if (!mounted) return;
      widget.onUpdated(AssetFace(
        id: widget.face.id,
        bbox: widget.face.bbox,
        confidence: widget.face.confidence,
      ));
      nav.pop();
    } catch (e) {
      if (mounted) setState(() { _saving = false; _saveError = e.toString(); });
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filtered;
    final query = _ctrl.text.trim();
    final exactMatch = widget.persons.any(
      (p) => (p.name ?? "").toLowerCase() == query.toLowerCase(),
    );

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.65,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 8),
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.black26,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Text(
                  widget.face.personName != null
                      ? "Reassign: ${widget.face.personName}"
                      : "Who is this?",
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  controller: _ctrl,
                  autofocus: true,
                  decoration: const InputDecoration(
                    hintText: "Search or type a name…",
                    prefixIcon: Icon(Icons.search),
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              if (_saveError != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  child: Text(
                    _saveError!,
                    style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12),
                  ),
                ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    if (query.isNotEmpty && !exactMatch)
                      ListTile(
                        leading: const Icon(Icons.person_add_outlined),
                        title: Text('Create "$query"'),
                        onTap: _saving ? null : _createAndAssign,
                      ),
                    if (widget.face.personId != null)
                      ListTile(
                        leading: const Icon(Icons.person_remove_outlined),
                        title: const Text("Remove assignment"),
                        onTap: _saving ? null : _clearAssignment,
                      ),
                    ...filtered.map(
                      (p) => ListTile(
                        leading: const Icon(Icons.person_outline),
                        title: Text(p.name ?? "Unnamed"),
                        subtitle: Text("${p.instanceCount} photos"),
                        onTap: _saving ? null : () => _assignTo(p),
                      ),
                    ),
                  ],
                ),
              ),
              if (_saving)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
