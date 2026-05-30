// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.11 — Google Drive import.
//
// OAuth2 via google_sign_in (drive.readonly scope). Lists importable files
// (images / videos / PDFs) from the user's Drive, newest first, paginated.
// The user multi-selects; "Import (N)" downloads each via the Drive media
// endpoint (Authorization: Bearer) → tmp file → sha256 → UploadQueue → drain.
//
// ⚠ Operator gate: the GCP project (fonto-yourproject) must have the Google Drive
// API enabled and the drive.readonly scope on the OAuth consent screen. In
// Testing mode this restricted scope works for registered test users without
// Google's verification/security assessment (required only for production).

import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../state/upload_queue.dart";

const _kDriveApiBase = "https://www.googleapis.com/drive/v3";
const _kDriveScope = "https://www.googleapis.com/auth/drive.readonly";

// Module-level singleton so sign-in state survives screen push/pop.
final _driveSignIn = GoogleSignIn(scopes: [_kDriveScope]);

// Top-level so it runs independently of any widget lifecycle — the user can
// navigate away and downloads + uploads continue. After each enqueue, drain()
// is kicked (no-op if already running) so uploads pipeline alongside downloads
// rather than waiting for all files to land before any upload starts.
Future<void> _downloadAndEnqueueAll(
  List<_DriveItem> items,
  String virtualPath,
  Map<String, String> headers,
  Directory tmpDir,
) async {
  // Mark "still feeding" so the single live drain holds open (and the upload
  // bar stays put) across the slow gaps between downloads instead of exiting
  // and re-spawning per file — that cycle is what flickered "0 of 1".
  UploadQueue.beginFeeding();
  try {
    for (final item in items) {
      try {
        final uri = Uri.parse("$_kDriveApiBase/files/${item.id}")
            .replace(queryParameters: {"alt": "media"});
        final req = http.Request("GET", uri)..headers.addAll(headers);
        final streamed = await http.Client().send(req);
        if (streamed.statusCode != 200) continue;
        final fname = item.name.isNotEmpty ? item.name : "${item.id}.bin";
        final tmp = File("${tmpDir.path}/drive_${item.id}_$fname");
        final sink = tmp.openWrite();
        await streamed.stream.pipe(sink);
        // hashFile reads the file in small chunks so SHA256 never
        // blocks the isolate long enough to trigger an ANR.
        final sha = await UploadQueue.hashFile(tmp);
        final q = await UploadQueue.open();
        await q.enqueue(
          filePath: tmp.path,
          virtualPath: virtualPath,
          sha256Hex: sha,
        );
        // Kick drain after each enqueue: no-op if already running.
        unawaited(UploadQueue.drain());
      } catch (_) {
        // Skip this file; continue with the rest.
      }
    }
  } finally {
    UploadQueue.endFeeding();
  }
  // Fire-and-forget (never await): when feeders hit 0 the live drain finishes
  // the tail. Awaiting here would deadlock the import-all page loop, which
  // calls this per page while its own feeder ref is still held.
  unawaited(UploadQueue.drain());
}

// Paginates through ALL Drive files and feeds each page into
// _downloadAndEnqueueAll. Used by "Import all" so the UI list never needs to
// be fully loaded into memory.
Future<void> _downloadAllPagesFromDrive(
  Map<String, String> headers,
  String virtualPath,
  Directory tmpDir,
) async {
  // Hold a feeder ref across the whole paginated import so the drain (and the
  // upload bar) stay alive between pages too.
  UploadQueue.beginFeeding();
  try {
    String? pageToken;
    do {
      try {
        final query = {
          "q": "trashed = false and (mimeType contains 'image/' or "
              "mimeType contains 'video/' or mimeType = 'application/pdf')",
          "fields": "nextPageToken, files(id, name, mimeType, size)",
          "pageSize": "100",
          "orderBy": "modifiedTime desc",
          "spaces": "drive",
          if (pageToken != null) "pageToken": pageToken,
        };
        final uri =
            Uri.parse("$_kDriveApiBase/files").replace(queryParameters: query);
        final res = await http.get(uri, headers: headers);
        if (res.statusCode != 200) break;
        final j = json.decode(res.body) as Map<String, dynamic>;
        final items = (j["files"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(_DriveItem.fromJson)
            .toList();
        await _downloadAndEnqueueAll(items, virtualPath, headers, tmpDir);
        pageToken = j["nextPageToken"] as String?;
      } catch (_) {
        break;
      }
    } while (pageToken != null);
  } finally {
    UploadQueue.endFeeding();
  }
  unawaited(UploadQueue.drain());
}

class GoogleDriveImportScreen extends StatefulWidget {
  const GoogleDriveImportScreen({super.key, required this.virtualPath});

  /// The Fonto directory path new assets should land in.
  final String virtualPath;

  @override
  State<GoogleDriveImportScreen> createState() =>
      _GoogleDriveImportScreenState();
}

class _GoogleDriveImportScreenState extends State<GoogleDriveImportScreen> {
  final _scroll = ScrollController();

  GoogleSignInAccount? _user;
  bool _signingIn = false;
  String? _signInError;

  final List<_DriveItem> _items = [];
  bool _loading = false;
  String? _nextPage;

  final Map<String, _DriveItem> _selected = {};
  bool _importing = false;
  bool _selectingAll = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
    _tryRestoreSession();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _maybeLoadMore() {
    if (!_scroll.hasClients) return;
    if (_scroll.position.pixels <
        _scroll.position.maxScrollExtent - 400) {
      return;
    }
    if (!_loading && _nextPage != null) _loadFiles(more: true);
  }

  Future<void> _tryRestoreSession() async {
    setState(() => _signingIn = true);
    try {
      final user = await _driveSignIn.signInSilently();
      if (!mounted) return;
      setState(() {
        _user = user;
        _signingIn = false;
      });
      if (user != null) _loadFiles();
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
      final user = await _driveSignIn.signIn();
      if (!mounted) return;
      setState(() {
        _user = user;
        _signingIn = false;
      });
      if (user != null) _loadFiles();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _signingIn = false;
        _signInError = "Sign-in failed: $e";
      });
    }
  }

  Future<Map<String, String>> _authHeaders() async {
    final user = _user;
    if (user == null) return {};
    final auth = await user.authentication;
    final token = auth.accessToken;
    return token == null ? {} : {"Authorization": "Bearer $token"};
  }

  Future<void> _loadFiles({bool more = false}) async {
    if (_loading) return;
    setState(() => _loading = true);
    try {
      final headers = await _authHeaders();
      final query = {
        "q": "trashed = false and (mimeType contains 'image/' or "
            "mimeType contains 'video/' or mimeType = 'application/pdf')",
        "fields": "nextPageToken, files(id, name, mimeType, size)",
        "pageSize": "100",
        "orderBy": "modifiedTime desc",
        "spaces": "drive",
        if (more && _nextPage != null) "pageToken": _nextPage!,
      };
      final uri =
          Uri.parse("$_kDriveApiBase/files").replace(queryParameters: query);
      final res = await http.get(uri, headers: headers);
      if (res.statusCode != 200) {
        if (!mounted) return;
        setState(() => _loading = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Drive list failed: ${res.statusCode}")),
        );
        return;
      }
      final j = json.decode(res.body) as Map<String, dynamic>;
      final files = (j["files"] as List? ?? const [])
          .cast<Map<String, dynamic>>()
          .map(_DriveItem.fromJson)
          .toList();
      if (!mounted) return;
      setState(() {
        if (more) {
          _items.addAll(files);
        } else {
          _items
            ..clear()
            ..addAll(files);
        }
        _nextPage = j["nextPageToken"] as String?;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Drive list error: $e")),
      );
    }
  }

  void _toggle(_DriveItem item) {
    setState(() {
      if (_selected.containsKey(item.id)) {
        _selected.remove(item.id);
      } else {
        _selected[item.id] = item;
      }
    });
  }

  // Deselect if anything is selected; otherwise load ALL pages then select
  // everything — so "select all" truly means every file in Drive, not just
  // the first 100.
  Future<void> _toggleSelectAll() async {
    if (_selectingAll) return;
    if (_selected.isNotEmpty) {
      setState(() => _selected.clear());
      return;
    }
    // Select whatever is already loaded, then fetch remaining pages.
    setState(() {
      for (final it in _items) {
        _selected[it.id] = it;
      }
      _selectingAll = _nextPage != null;
    });
    while (_nextPage != null && mounted) {
      await _loadFiles(more: true);
      if (mounted) {
        setState(() {
          for (final it in _items) {
            _selected[it.id] = it;
          }
        });
      }
    }
    if (mounted) setState(() => _selectingAll = false);
  }

  // Import EVERY file in Drive without browsing — paginates server-side and
  // feeds directly into the download queue.
  Future<void> _importAll() async {
    if (_importing) return;
    setState(() => _importing = true);
    try {
      final headers = await _authHeaders();
      final tmpDir = await getTemporaryDirectory();
      unawaited(_downloadAllPagesFromDrive(headers, widget.virtualPath, tmpDir));
    } finally {
      if (mounted) setState(() => _importing = false);
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("Importing all Drive files in the background."),
      ),
    );
    Navigator.of(context).pop(true);
  }

  Future<void> _import() async {
    if (_selected.isEmpty || _importing) return;
    final items = List<_DriveItem>.from(_selected.values);
    final virtualPath = widget.virtualPath;

    setState(() => _importing = true);

    try {
      final headers = await _authHeaders();
      final tmpDir = await getTemporaryDirectory();

      // Hand off to a top-level function so work continues even if the user
      // navigates away and this widget is disposed mid-download.
      unawaited(_downloadAndEnqueueAll(items, virtualPath, headers, tmpDir));
    } finally {
      if (mounted) setState(() => _importing = false);
    }

    if (!mounted) return;
    final n = items.length;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          "Downloading $n file${n == 1 ? '' : 's'} — uploading in the background.",
        ),
      ),
    );
    Navigator.of(context).pop(true);
  }

  IconData _iconFor(String mime) {
    if (mime.startsWith("video/")) return Icons.movie_outlined;
    if (mime == "application/pdf") return Icons.picture_as_pdf_outlined;
    return Icons.image_outlined;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Import from Google Drive"),
        actions: [
          if (_user != null && _items.isNotEmpty) ...[
            if (_selectingAll)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 12),
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            else
              IconButton(
                tooltip: _selected.isNotEmpty ? "Deselect all" : "Select all",
                icon: Icon(
                  _selected.isNotEmpty ? Icons.deselect : Icons.select_all,
                ),
                onPressed: _toggleSelectAll,
              ),
          ],
          if (_user != null)
            PopupMenuButton<String>(
              onSelected: (v) async {
                if (v == "import_all") await _importAll();
                if (v == "sign_out") {
                  await _driveSignIn.signOut();
                  if (!mounted) return;
                  setState(() {
                    _user = null;
                    _items.clear();
                    _selected.clear();
                    _nextPage = null;
                  });
                }
              },
              itemBuilder: (_) => [
                const PopupMenuItem(
                  value: "import_all",
                  child: Text("Import all from Drive"),
                ),
                const PopupMenuItem(
                  value: "sign_out",
                  child: Text("Sign out"),
                ),
              ],
            ),
        ],
      ),
      floatingActionButton: _selected.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: _importing ? null : _import,
              icon: _importing
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.download),
              label: Text(
                _importing ? "Starting…" : "Import (${_selected.length})",
              ),
            ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_user == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.folder_shared_outlined, size: 48),
              const SizedBox(height: 16),
              const Text(
                "Connect Google Drive to import your files into Fonto.",
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _signingIn ? null : _signIn,
                icon: const Icon(Icons.login),
                label: Text(_signingIn ? "Connecting…" : "Connect Google Drive"),
              ),
              if (_signInError != null) ...[
                const SizedBox(height: 12),
                Text(
                  _signInError!,
                  style: const TextStyle(color: Colors.red),
                  textAlign: TextAlign.center,
                ),
              ],
            ],
          ),
        ),
      );
    }

    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty) {
      return const Center(child: Text("No importable files found in Drive."));
    }

    return ListView.builder(
      controller: _scroll,
      itemCount: _items.length + (_nextPage != null ? 1 : 0),
      itemBuilder: (context, i) {
        if (i >= _items.length) {
          return const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        final item = _items[i];
        final sel = _selected.containsKey(item.id);
        return CheckboxListTile(
          value: sel,
          onChanged: (_) => _toggle(item),
          secondary: Icon(_iconFor(item.mimeType)),
          title: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text(item.sizeLabel),
          controlAffinity: ListTileControlAffinity.trailing,
        );
      },
    );
  }
}

class _DriveItem {
  _DriveItem({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.sizeBytes,
  });

  final String id;
  final String name;
  final String mimeType;
  final int sizeBytes;

  String get sizeLabel {
    if (sizeBytes <= 0) return mimeType;
    if (sizeBytes < 1024) return "$sizeBytes B";
    if (sizeBytes < 1024 * 1024) {
      return "${(sizeBytes / 1024).toStringAsFixed(0)} KB";
    }
    return "${(sizeBytes / (1024 * 1024)).toStringAsFixed(1)} MB";
  }

  static _DriveItem fromJson(Map<String, dynamic> j) => _DriveItem(
        id: j["id"] as String,
        name: (j["name"] as String?) ?? "",
        mimeType: (j["mimeType"] as String?) ?? "",
        sizeBytes: int.tryParse((j["size"] as String?) ?? "") ?? 0,
      );
}
