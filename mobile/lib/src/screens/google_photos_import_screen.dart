// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.8 — Google Photos import.
//
// OAuth2 via google_sign_in (photoslibrary.readonly scope). The screen has
// two tabs — Albums (list) and All Photos (paginated grid). The user picks
// any number of items across both tabs; tapping "Import (N)" downloads each
// item to a tmp file, hashes it, and enqueues it through the existing
// UploadQueue → drain path.
//
// ⚠ Operator gate: before this flow works end-to-end the operator must:
//   1. Create a Google Cloud project with the Photos Library API enabled.
//   2. Create an OAuth 2.0 Web application client; paste the client ID into
//      android/app/src/main/res/values/strings.xml as default_web_client_id.
//   3. Create an OAuth 2.0 Android client for package com.joeybuilt.fonto
//      with the SHA-1 fingerprint of the upload keystore.
// Until that's done the sign-in button shows an error toast.

import "dart:convert";
import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:crypto/crypto.dart";
import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../state/upload_queue.dart";

const _kPhotosApiBase = "https://photoslibrary.googleapis.com/v1";
const _kPhotosScope =
    "https://www.googleapis.com/auth/photoslibrary.readonly";

// Module-level singleton so the sign-in state survives screen push/pop.
final _gSignIn = GoogleSignIn(scopes: [_kPhotosScope]);

class GooglePhotosImportScreen extends StatefulWidget {
  const GooglePhotosImportScreen({
    super.key,
    required this.virtualPath,
  });

  /// The Fonto directory path new assets should land in.
  final String virtualPath;

  @override
  State<GooglePhotosImportScreen> createState() =>
      _GooglePhotosImportScreenState();
}

class _GooglePhotosImportScreenState extends State<GooglePhotosImportScreen>
    with SingleTickerProviderStateMixin {
  late final _tabs = TabController(length: 2, vsync: this);

  GoogleSignInAccount? _gUser;
  bool _signingIn = false;
  String? _signInError;

  // Albums tab
  List<_GpAlbum> _albums = [];
  bool _loadingAlbums = false;

  // All Photos tab
  List<_GpItem> _allItems = [];
  bool _loadingAll = false;
  String? _allNextPage;

  // Cross-tab selection (id → item)
  final Map<String, _GpItem> _selected = {};

  bool _importing = false;
  int _importDone = 0;
  int _importTotal = 0;

  @override
  void initState() {
    super.initState();
    _tryRestoreSession();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _tryRestoreSession() async {
    setState(() => _signingIn = true);
    try {
      final user = await _gSignIn.signInSilently();
      if (!mounted) return;
      if (user != null) {
        setState(() {
          _gUser = user;
          _signingIn = false;
        });
        _loadAlbums();
        _loadAllPhotos();
      } else {
        setState(() => _signingIn = false);
      }
    } catch (_) {
      if (mounted) setState(() => _signingIn = false);
    }
  }

  Future<void> _signIn() async {
    setState(() {
      _signingIn = true;
      _signInError = null;
    });
    try {
      final user = await _gSignIn.signIn();
      if (!mounted) return;
      if (user == null) {
        // User cancelled.
        setState(() => _signingIn = false);
        return;
      }
      setState(() {
        _gUser = user;
        _signingIn = false;
      });
      _loadAlbums();
      _loadAllPhotos();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _signingIn = false;
        _signInError = e.toString();
      });
    }
  }

  Future<String?> _token() async {
    final auth = await _gUser?.authentication;
    return auth?.accessToken;
  }

  // ── Albums ──────────────────────────────────────────────────────────────

  Future<void> _loadAlbums() async {
    setState(() => _loadingAlbums = true);
    try {
      final token = await _token();
      if (token == null) return;
      final res = await http.get(
        Uri.parse("$_kPhotosApiBase/albums?pageSize=50"),
        headers: {"Authorization": "Bearer $token"},
      );
      if (!mounted) return;
      if (res.statusCode == 200) {
        final j = json.decode(res.body) as Map<String, dynamic>;
        final raw =
            (j["albums"] as List? ?? const []).cast<Map<String, dynamic>>();
        setState(() {
          _albums = raw.map(_GpAlbum.fromJson).toList();
          _loadingAlbums = false;
        });
      } else {
        setState(() => _loadingAlbums = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loadingAlbums = false);
    }
  }

  // ── All Photos ───────────────────────────────────────────────────────────

  Future<void> _loadAllPhotos({bool more = false}) async {
    if (_loadingAll) return;
    if (more && _allNextPage == null) return;
    setState(() => _loadingAll = true);
    try {
      final token = await _token();
      if (token == null) return;
      final body = <String, dynamic>{"pageSize": 100};
      if (more && _allNextPage != null) body["pageToken"] = _allNextPage;
      final res = await http.post(
        Uri.parse("$_kPhotosApiBase/mediaItems:search"),
        headers: {
          "Authorization": "Bearer $token",
          "Content-Type": "application/json",
        },
        body: json.encode(body),
      );
      if (!mounted) return;
      if (res.statusCode == 200) {
        final j = json.decode(res.body) as Map<String, dynamic>;
        final items = (j["mediaItems"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(_GpItem.fromJson)
            .toList();
        setState(() {
          if (more) {
            _allItems.addAll(items);
          } else {
            _allItems = items;
          }
          _allNextPage = j["nextPageToken"] as String?;
          _loadingAll = false;
        });
      } else {
        setState(() => _loadingAll = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loadingAll = false);
    }
  }

  // ── Selection ────────────────────────────────────────────────────────────

  void _toggle(_GpItem item) {
    setState(() {
      if (_selected.containsKey(item.id)) {
        _selected.remove(item.id);
      } else {
        _selected[item.id] = item;
      }
    });
  }

  // ── Import ───────────────────────────────────────────────────────────────

  Future<void> _import() async {
    if (_selected.isEmpty || _importing) return;
    final items = List<_GpItem>.from(_selected.values);
    setState(() {
      _importing = true;
      _importDone = 0;
      _importTotal = items.length;
    });

    int ok = 0;
    try {
      final tmpDir = await getTemporaryDirectory();
      for (final item in items) {
        if (!mounted) return;
        try {
          // Append =d (photo) or =dv (video) to baseUrl for full-res download.
          final dlUrl = item.isVideo
              ? "${item.baseUrl}=dv"
              : "${item.baseUrl}=d";
          final res = await http.get(Uri.parse(dlUrl));
          if (res.statusCode != 200) {
            setState(() => _importDone++);
            continue;
          }
          final fname = item.filename.isNotEmpty
              ? item.filename
              : "${item.id}.jpg";
          final tmp = File("${tmpDir.path}/gp_${item.id}_$fname");
          await tmp.writeAsBytes(res.bodyBytes);
          final sha = sha256.convert(res.bodyBytes).toString();
          final q = await UploadQueue.open();
          await q.enqueue(
            filePath: tmp.path,
            virtualPath: widget.virtualPath,
            sha256Hex: sha,
          );
          ok++;
        } catch (_) {
          // Skip this item; continue with rest.
        }
        setState(() => _importDone++);
      }
      await UploadQueue.drain();
    } finally {
      if (mounted) setState(() => _importing = false);
    }

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text("Queued $ok / ${items.length} for upload to Fonto."),
      ),
    );
    Navigator.of(context).pop(ok > 0);
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Import from Google Photos"),
        actions: [
          if (_gUser != null && _selected.isNotEmpty)
            TextButton(
              onPressed: _importing ? null : _import,
              child: Text("Import (${_selected.length})"),
            ),
        ],
        bottom: _gUser == null
            ? null
            : TabBar(
                controller: _tabs,
                tabs: const [Tab(text: "Albums"), Tab(text: "All Photos")],
              ),
      ),
      body: _signingIn
          ? const Center(child: CircularProgressIndicator())
          : _importing
              ? _ImportProgress(done: _importDone, total: _importTotal)
              : _gUser == null
                  ? _SignInPrompt(
                      error: _signInError,
                      onSignIn: _signIn,
                    )
                  : TabBarView(
                      controller: _tabs,
                      children: [
                        _AlbumsTab(
                          albums: _albums,
                          loading: _loadingAlbums,
                          selected: _selected,
                          onToggle: _toggle,
                          onImport: _import,
                          importing: _importing,
                        ),
                        _AllPhotosTab(
                          items: _allItems,
                          loading: _loadingAll,
                          hasMore: _allNextPage != null,
                          selected: _selected,
                          onToggle: _toggle,
                          onLoadMore: () => _loadAllPhotos(more: true),
                        ),
                      ],
                    ),
    );
  }
}

// ── Sign-in prompt ────────────────────────────────────────────────────────

class _SignInPrompt extends StatelessWidget {
  const _SignInPrompt({required this.error, required this.onSignIn});
  final String? error;
  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.photo_library_outlined, size: 64),
            const SizedBox(height: 16),
            const Text(
              "Connect Google Photos to browse and import your library.",
              textAlign: TextAlign.center,
            ),
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(
                error!,
                style:
                    TextStyle(color: Theme.of(context).colorScheme.error),
                textAlign: TextAlign.center,
              ),
            ],
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onSignIn,
              icon: const Icon(Icons.login),
              label: const Text("Sign in with Google"),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Import progress ───────────────────────────────────────────────────────

class _ImportProgress extends StatelessWidget {
  const _ImportProgress({required this.done, required this.total});
  final int done;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(
            value: total > 0 ? done / total : null,
          ),
          const SizedBox(height: 16),
          Text(
            "Downloading $done / $total",
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ],
      ),
    );
  }
}

// ── Albums tab ────────────────────────────────────────────────────────────

class _AlbumsTab extends StatelessWidget {
  const _AlbumsTab({
    required this.albums,
    required this.loading,
    required this.selected,
    required this.onToggle,
    required this.onImport,
    required this.importing,
  });
  final List<_GpAlbum> albums;
  final bool loading;
  final Map<String, _GpItem> selected;
  final void Function(_GpItem) onToggle;
  final Future<void> Function() onImport;
  final bool importing;

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (albums.isEmpty) {
      return const Center(child: Text("No albums found."));
    }
    return ListView.builder(
      itemCount: albums.length,
      itemBuilder: (ctx, i) {
        final album = albums[i];
        return ListTile(
          leading: album.coverUrl != null
              ? ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: CachedNetworkImage(
                    imageUrl: "${album.coverUrl}=w72-h72-c",
                    width: 48,
                    height: 48,
                    fit: BoxFit.cover,
                    errorWidget: (_, __, ___) =>
                        const Icon(Icons.photo_album),
                  ),
                )
              : const Icon(Icons.photo_album),
          title: Text(album.title),
          subtitle: Text("${album.count} items"),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.of(ctx).push(
            MaterialPageRoute<bool>(
              builder: (_) => _AlbumDetailScreen(
                album: album,
                selected: selected,
                onToggle: onToggle,
                onImport: onImport,
                importing: importing,
              ),
            ),
          ),
        );
      },
    );
  }
}

// ── Album detail screen ───────────────────────────────────────────────────

class _AlbumDetailScreen extends StatefulWidget {
  const _AlbumDetailScreen({
    required this.album,
    required this.selected,
    required this.onToggle,
    required this.onImport,
    required this.importing,
  });
  final _GpAlbum album;
  final Map<String, _GpItem> selected;
  final void Function(_GpItem) onToggle;
  final Future<void> Function() onImport;
  final bool importing;

  @override
  State<_AlbumDetailScreen> createState() => _AlbumDetailScreenState();
}

class _AlbumDetailScreenState extends State<_AlbumDetailScreen> {
  List<_GpItem> _items = [];
  bool _loading = true;
  String? _nextPage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    if (_loading && more) return;
    setState(() => _loading = true);
    try {
      final auth = await _gSignIn.currentUser?.authentication;
      final token = auth?.accessToken;
      if (token == null) return;
      final body = <String, dynamic>{
        "albumId": widget.album.id,
        "pageSize": 100,
      };
      if (more && _nextPage != null) body["pageToken"] = _nextPage;
      final res = await http.post(
        Uri.parse("$_kPhotosApiBase/mediaItems:search"),
        headers: {
          "Authorization": "Bearer $token",
          "Content-Type": "application/json",
        },
        body: json.encode(body),
      );
      if (!mounted) return;
      if (res.statusCode == 200) {
        final j = json.decode(res.body) as Map<String, dynamic>;
        final items = (j["mediaItems"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(_GpItem.fromJson)
            .toList();
        setState(() {
          if (more) {
            _items.addAll(items);
          } else {
            _items = items;
          }
          _nextPage = j["nextPageToken"] as String?;
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final selCount = widget.selected.length;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.album.title),
        actions: [
          if (selCount > 0)
            TextButton(
              onPressed: widget.importing
                  ? null
                  : () async {
                      await widget.onImport();
                      if (context.mounted) Navigator.of(context).pop(true);
                    },
              child: Text("Import ($selCount)"),
            ),
        ],
      ),
      body: _loading && _items.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : NotificationListener<ScrollNotification>(
              onNotification: (n) {
                if (n is ScrollEndNotification &&
                    n.metrics.extentAfter < 300 &&
                    _nextPage != null) {
                  _load(more: true);
                }
                return false;
              },
              child: GridView.builder(
                padding: const EdgeInsets.all(2),
                gridDelegate:
                    const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  crossAxisSpacing: 2,
                  mainAxisSpacing: 2,
                ),
                itemCount: _items.length + (_loading ? 1 : 0),
                itemBuilder: (_, i) {
                  if (i == _items.length) {
                    return const Center(
                        child: CircularProgressIndicator());
                  }
                  final item = _items[i];
                  return _MediaTile(
                    item: item,
                    selected: widget.selected.containsKey(item.id),
                    onTap: () => setState(() => widget.onToggle(item)),
                  );
                },
              ),
            ),
    );
  }
}

// ── All Photos tab ────────────────────────────────────────────────────────

class _AllPhotosTab extends StatelessWidget {
  const _AllPhotosTab({
    required this.items,
    required this.loading,
    required this.hasMore,
    required this.selected,
    required this.onToggle,
    required this.onLoadMore,
  });
  final List<_GpItem> items;
  final bool loading;
  final bool hasMore;
  final Map<String, _GpItem> selected;
  final void Function(_GpItem) onToggle;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (loading && items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    return NotificationListener<ScrollNotification>(
      onNotification: (n) {
        if (n is ScrollEndNotification &&
            n.metrics.extentAfter < 300 &&
            hasMore) {
          onLoadMore();
        }
        return false;
      },
      child: GridView.builder(
        padding: const EdgeInsets.all(2),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 2,
          mainAxisSpacing: 2,
        ),
        itemCount: items.length + (loading ? 1 : 0),
        itemBuilder: (_, i) {
          if (i == items.length) {
            return const Center(child: CircularProgressIndicator());
          }
          final item = items[i];
          return _MediaTile(
            item: item,
            selected: selected.containsKey(item.id),
            onTap: () => onToggle(item),
          );
        },
      ),
    );
  }
}

// ── Media tile ────────────────────────────────────────────────────────────

class _MediaTile extends StatelessWidget {
  const _MediaTile({
    required this.item,
    required this.selected,
    required this.onTap,
  });
  final _GpItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Stack(
        fit: StackFit.expand,
        children: [
          CachedNetworkImage(
            imageUrl: "${item.baseUrl}=w200-h200-c",
            fit: BoxFit.cover,
            errorWidget: (_, __, ___) =>
                const ColoredBox(color: Colors.black12),
          ),
          if (item.isVideo)
            const Align(
              alignment: Alignment.bottomLeft,
              child: Padding(
                padding: EdgeInsets.all(4),
                child: Icon(
                  Icons.play_circle_outline,
                  color: Colors.white,
                  size: 18,
                  shadows: [Shadow(blurRadius: 4, color: Colors.black54)],
                ),
              ),
            ),
          if (selected)
            Container(
              color: Colors.blue.withAlpha(128),
              alignment: Alignment.topRight,
              padding: const EdgeInsets.all(4),
              child: const Icon(
                Icons.check_circle,
                color: Colors.white,
                size: 22,
                shadows: [Shadow(blurRadius: 4, color: Colors.black54)],
              ),
            ),
        ],
      ),
    );
  }
}

// ── Data classes ──────────────────────────────────────────────────────────

class _GpAlbum {
  const _GpAlbum({
    required this.id,
    required this.title,
    required this.count,
    this.coverUrl,
  });
  final String id;
  final String title;
  final int count;
  final String? coverUrl;

  factory _GpAlbum.fromJson(Map<String, dynamic> j) => _GpAlbum(
        id: j["id"] as String,
        title: (j["title"] as String?) ?? "Untitled album",
        count:
            int.tryParse((j["mediaItemsCount"] ?? "0").toString()) ?? 0,
        coverUrl: j["coverPhotoBaseUrl"] as String?,
      );
}

class _GpItem {
  const _GpItem({
    required this.id,
    required this.baseUrl,
    required this.filename,
    required this.isVideo,
  });
  final String id;
  final String baseUrl;
  final String filename;
  final bool isVideo;

  factory _GpItem.fromJson(Map<String, dynamic> j) {
    final meta = (j["mediaMetadata"] as Map<String, dynamic>?) ?? {};
    return _GpItem(
      id: j["id"] as String,
      baseUrl: j["baseUrl"] as String,
      filename: (j["filename"] as String?) ?? "",
      isVideo: meta.containsKey("video"),
    );
  }
}
