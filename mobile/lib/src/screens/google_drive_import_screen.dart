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

import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";
import "package:workmanager/workmanager.dart";

import "../state/drive_download_queue.dart";
import "../state/upload_queue.dart";

const _kDriveApiBase = "https://www.googleapis.com/drive/v3";
const _kDriveScope = "https://www.googleapis.com/auth/drive.readonly";

// Module-level singleton so sign-in state survives screen push/pop.
final _driveSignIn = GoogleSignIn(scopes: [_kDriveScope]);

// Top-level so it runs independently of any widget lifecycle — the user can
// navigate away and downloads + uploads continue in the foreground.
// Items are persisted to DriveDownloadQueue first, so a WorkManager task
// can resume anything not completed if the process is killed.
Future<void> _downloadAndEnqueueAll(
  List<_DriveItem> items,
  String virtualPath,
  GoogleSignInAccount account,
) async {
  DriveDownloadQueue.totalEnqueued.value = 0;
  // 1. Persist to the durable queue before downloading anything.
  final driveQ = await DriveDownloadQueue.open();
  await driveQ.enqueue(
    items
        .map((i) => (id: i.id, name: i.name, mimeType: i.mimeType))
        .toList(),
    virtualPath,
  );

  // 2. Process in the foreground; hold the upload drain open the whole time.
  // Refresh the auth token before each batch — OAuth tokens expire in ~1 hour,
  // and a large import easily spans that window.
  UploadQueue.beginFeeding();
  try {
    int downloaded;
    do {
      final auth = await account.authentication;
      final token = auth.accessToken;
      final headers =
          token == null ? <String, String>{} : {"Authorization": "Bearer $token"};
      downloaded = await DriveDownloadQueue.processAll(
        headers,
        await getTemporaryDirectory(),
      );
    } while (downloaded > 0);
  } finally {
    UploadQueue.endFeeding();
    unawaited(UploadQueue.drain());
  }
}

// Paginates through ALL Drive files, persisting each page to DriveDownloadQueue
// and processing in the foreground. Used by "Import all."
Future<void> _downloadAllPagesFromDrive(
  GoogleSignInAccount account,
  String virtualPath,
) async {
  DriveDownloadQueue.totalEnqueued.value = 0;
  DriveDownloadQueue.importingAll.value = true;
  UploadQueue.beginFeeding();
  try {
    // Phase 1: walk ALL Drive pages and persist every file to the durable
    // queue before downloading anything. Separating enumeration from download
    // means a transient network error during download cannot abort pagination —
    // every file that exists in Drive will be enqueued.
    final driveQ = await DriveDownloadQueue.open();
    String? pageToken;
    do {
      // Refresh token each listing page — pagination across a large Drive can
      // span the 1-hour OAuth token lifetime.
      final listAuth = await account.authentication;
      final listToken = listAuth.accessToken;
      final listHeaders = listToken == null
          ? <String, String>{}
          : {"Authorization": "Bearer $listToken"};
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
      final res = await http.get(uri, headers: listHeaders);
      if (res.statusCode != 200) break;
      final j = json.decode(res.body) as Map<String, dynamic>;
      final items = (j["files"] as List? ?? const [])
          .cast<Map<String, dynamic>>()
          .map(_DriveItem.fromJson)
          .toList();
      await driveQ.enqueue(
        items.map((i) => (id: i.id, name: i.name, mimeType: i.mimeType)).toList(),
        virtualPath,
      );
      pageToken = j["nextPageToken"] as String?;
    } while (pageToken != null);

    // Phase 2: all files are now in the durable queue.
    // Switch banner from "importing all…" to "downloading N files".
    DriveDownloadQueue.importingAll.value = false;
    // Loop on pendingCount, not on downloaded > 0. The previous approach
    // exited prematurely when a batch returned 0 successes (auth expiry,
    // transient error) even though pending items remained in the queue.
    // Refresh the token before each batch to survive the 1-hour expiry window.
    int consecutiveZeros = 0;
    while (await driveQ.pendingCount() > 0 && consecutiveZeros < 3) {
      final dlAuth = await account.authentication;
      final dlToken = dlAuth.accessToken;
      final dlHeaders = dlToken == null
          ? <String, String>{}
          : {"Authorization": "Bearer $dlToken"};
      final downloaded = await DriveDownloadQueue.processAll(
        dlHeaders,
        await getTemporaryDirectory(),
      );
      if (downloaded == 0) {
        consecutiveZeros++;
        await Future.delayed(const Duration(seconds: 5));
      } else {
        consecutiveZeros = 0;
      }
    }
  } finally {
    UploadQueue.endFeeding();
    DriveDownloadQueue.importingAll.value = false;
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
    final account = _user;
    if (account == null) return;
    setState(() => _importing = true);
    try {
      // Schedule WorkManager as the background fallback before we start —
      // if the process is killed mid-pagination the task resumes from the queue.
      unawaited(Workmanager().registerOneOffTask(
        kDriveDownloadTask, kDriveDownloadTask,
        existingWorkPolicy: ExistingWorkPolicy.keep,
        constraints: Constraints(networkType: NetworkType.connected),
      ));
      unawaited(_downloadAllPagesFromDrive(account, widget.virtualPath));
    } finally {
      if (mounted) setState(() => _importing = false);
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("Importing all Drive files — continues even if you leave."),
      ),
    );
    Navigator.of(context).pop(true);
  }

  Future<void> _import() async {
    if (_selected.isEmpty || _importing) return;
    final account = _user;
    if (account == null) return;
    final items = List<_DriveItem>.from(_selected.values);
    final virtualPath = widget.virtualPath;

    setState(() => _importing = true);

    try {
      // Schedule WorkManager as the background fallback before downloading —
      // surviving process death requires both the persistent queue and the task.
      unawaited(Workmanager().registerOneOffTask(
        kDriveDownloadTask, kDriveDownloadTask,
        existingWorkPolicy: ExistingWorkPolicy.keep,
        constraints: Constraints(networkType: NetworkType.connected),
      ));
      // Hand off to a top-level function so downloads continue even if the
      // user navigates away and this widget is disposed mid-download.
      unawaited(_downloadAndEnqueueAll(items, virtualPath, account));
    } finally {
      if (mounted) setState(() => _importing = false);
    }

    if (!mounted) return;
    final n = items.length;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          "Downloading $n file${n == 1 ? '' : 's'} — continues even if you leave.",
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
