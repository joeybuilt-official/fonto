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

import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../state/upload_queue.dart";

const _kDriveApiBase = "https://www.googleapis.com/drive/v3";
const _kDriveScope = "https://www.googleapis.com/auth/drive.readonly";

// Module-level singleton so sign-in state survives screen push/pop.
final _driveSignIn = GoogleSignIn(scopes: [_kDriveScope]);

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
  int _importDone = 0;
  int _importTotal = 0;

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

  Future<void> _import() async {
    if (_selected.isEmpty || _importing) return;
    final items = List<_DriveItem>.from(_selected.values);
    setState(() {
      _importing = true;
      _importDone = 0;
      _importTotal = items.length;
    });

    var ok = 0;
    try {
      final headers = await _authHeaders();
      final tmpDir = await getTemporaryDirectory();
      for (final item in items) {
        if (!mounted) return;
        try {
          final uri = Uri.parse("$_kDriveApiBase/files/${item.id}")
              .replace(queryParameters: {"alt": "media"});
          final res = await http.get(uri, headers: headers);
          if (res.statusCode != 200) {
            setState(() => _importDone++);
            continue;
          }
          final fname = item.name.isNotEmpty ? item.name : "${item.id}.bin";
          final tmp = File("${tmpDir.path}/drive_${item.id}_$fname");
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
          // Skip; continue with the rest.
        }
        setState(() => _importDone++);
      }
      await UploadQueue.drain();
    } finally {
      if (mounted) setState(() => _importing = false);
    }

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("Queued $ok / ${items.length} for upload to Fonto.")),
    );
    Navigator.of(context).pop(ok > 0);
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
          if (_user != null)
            TextButton(
              onPressed: () async {
                await _driveSignIn.signOut();
                if (!mounted) return;
                setState(() {
                  _user = null;
                  _items.clear();
                  _selected.clear();
                  _nextPage = null;
                });
              },
              child: const Text("Sign out"),
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
                _importing
                    ? "Importing $_importDone/$_importTotal"
                    : "Import (${_selected.length})",
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
