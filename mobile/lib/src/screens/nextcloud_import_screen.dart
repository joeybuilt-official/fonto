// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.11 — Nextcloud import (WebDAV).
//
// Connect with a server URL + username + app-password (generated in
// Nextcloud → Settings → Security → "Create new app password"). Credentials
// are stored in flutter_secure_storage. The browser lists folders/files via
// PROPFIND (Depth: 1); selected files are downloaded with HTTP Basic auth →
// tmp file → sha256 → UploadQueue → drain.

import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../state/upload_queue.dart";

const _kNcUrl = "nextcloud.url";
const _kNcUser = "nextcloud.user";
const _kNcPass = "nextcloud.pass";

class NextcloudImportScreen extends StatefulWidget {
  const NextcloudImportScreen({super.key, required this.virtualPath});

  final String virtualPath;

  @override
  State<NextcloudImportScreen> createState() => _NextcloudImportScreenState();
}

class _NextcloudImportScreenState extends State<NextcloudImportScreen> {
  static const _storage = FlutterSecureStorage();

  bool _loadingCreds = true;
  String? _url; // origin, no trailing slash
  String? _user;
  String? _pass;

  // Browser state
  String _cwd = ""; // full WebDAV URL of the current directory (trailing /)
  String _davRoot = ""; // WebDAV base for the user (no trailing slash)
  final List<_NcEntry> _entries = [];
  bool _loading = false;
  String? _error;

  final Map<String, _NcEntry> _selected = {};
  bool _importing = false;
  int _importDone = 0;
  int _importTotal = 0;

  @override
  void initState() {
    super.initState();
    _loadCreds();
  }

  Future<void> _loadCreds() async {
    final url = await _storage.read(key: _kNcUrl);
    final user = await _storage.read(key: _kNcUser);
    final pass = await _storage.read(key: _kNcPass);
    if (!mounted) return;
    setState(() {
      _url = url;
      _user = user;
      _pass = pass;
      _loadingCreds = false;
    });
    if (url != null && user != null && pass != null) {
      _davRoot = "$url/remote.php/dav/files/$user";
      _cwd = "$_davRoot/";
      _list(_cwd);
    }
  }

  String get _basicAuth =>
      "Basic ${base64.encode(utf8.encode("$_user:$_pass"))}";

  Future<void> _connect(String url, String user, String pass) async {
    // Normalise: strip trailing slash, ensure scheme.
    var u = url.trim();
    if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u";
    while (u.endsWith("/")) {
      u = u.substring(0, u.length - 1);
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    final davRoot = "$u/remote.php/dav/files/${user.trim()}";
    final probe = await _propfind("$davRoot/", user.trim(), pass);
    if (!mounted) return;
    if (probe == null) {
      setState(() {
        _loading = false;
        _error = "Couldn't connect. Check the URL, username, and app-password.";
      });
      return;
    }
    await _storage.write(key: _kNcUrl, value: u);
    await _storage.write(key: _kNcUser, value: user.trim());
    await _storage.write(key: _kNcPass, value: pass);
    if (!mounted) return;
    setState(() {
      _url = u;
      _user = user.trim();
      _pass = pass;
      _davRoot = davRoot;
      _cwd = "$davRoot/";
      _entries
        ..clear()
        ..addAll(probe);
      _loading = false;
    });
  }

  Future<void> _disconnect() async {
    await _storage.delete(key: _kNcUrl);
    await _storage.delete(key: _kNcUser);
    await _storage.delete(key: _kNcPass);
    if (!mounted) return;
    setState(() {
      _url = null;
      _user = null;
      _pass = null;
      _entries.clear();
      _selected.clear();
    });
  }

  /// PROPFIND Depth:1 → list of child entries (excludes the directory itself).
  /// Returns null on failure.
  Future<List<_NcEntry>?> _propfind(String dirUrl, String user, String pass) async {
    try {
      final auth = "Basic ${base64.encode(utf8.encode("$user:$pass"))}";
      final req = http.Request("PROPFIND", Uri.parse(dirUrl))
        ..headers["Authorization"] = auth
        ..headers["Depth"] = "1"
        ..headers["Content-Type"] = "application/xml"
        ..body =
            '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
            '<d:resourcetype/><d:getcontentlength/><d:getcontenttype/>'
            '</d:prop></d:propfind>';
      final streamed = await http.Client().send(req);
      final res = await http.Response.fromStream(streamed);
      if (res.statusCode != 207) return null;
      return _parseMultistatus(res.body, dirUrl);
    } catch (_) {
      return null;
    }
  }

  // Lightweight WebDAV multistatus parse. Nextcloud emits the `d:` prefix.
  List<_NcEntry> _parseMultistatus(String xml, String dirUrl) {
    final origin =
        Uri.parse(_url ?? dirUrl).replace(path: "", query: "").toString();
    final dirPath = Uri.decodeFull(Uri.parse(dirUrl).path);
    final dirNorm = dirPath.endsWith("/") ? dirPath : "$dirPath/";
    final out = <_NcEntry>[];
    final responses = RegExp(r"<d:response>(.*?)</d:response>", dotAll: true)
        .allMatches(xml);
    for (final m in responses) {
      final block = m.group(1) ?? "";
      final href = RegExp(r"<d:href>(.*?)</d:href>").firstMatch(block)?.group(1);
      if (href == null) continue;
      final decodedPath = Uri.decodeFull(href);
      // Skip the directory entry itself (PROPFIND Depth:1 includes it first).
      final pathNorm = decodedPath.endsWith("/") ? decodedPath : "$decodedPath/";
      if (pathNorm == dirNorm) continue;
      final isDir = block.contains("<d:collection");
      final lenStr = RegExp(r"<d:getcontentlength>(\d+)</d:getcontentlength>")
          .firstMatch(block)
          ?.group(1);
      final mime = RegExp(r"<d:getcontenttype>(.*?)</d:getcontenttype>")
          .firstMatch(block)
          ?.group(1) ??
          "";
      // name = last non-empty path segment.
      final segs = decodedPath.split("/").where((s) => s.isNotEmpty).toList();
      final name = segs.isEmpty ? "/" : segs.last;
      out.add(_NcEntry(
        name: name,
        url: "$origin$href",
        isDir: isDir,
        mimeType: mime,
        sizeBytes: int.tryParse(lenStr ?? "") ?? 0,
      ));
    }
    // Folders first, then files; alphabetical within each.
    out.sort((a, b) {
      if (a.isDir != b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return out;
  }

  Future<void> _list(String dirUrl) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final entries = await _propfind(dirUrl, _user!, _pass!);
    if (!mounted) return;
    if (entries == null) {
      setState(() {
        _loading = false;
        _error = "Failed to list folder.";
      });
      return;
    }
    setState(() {
      _cwd = dirUrl;
      _entries
        ..clear()
        ..addAll(entries);
      _loading = false;
    });
  }

  void _open(_NcEntry e) {
    if (e.isDir) {
      _list(e.url.endsWith("/") ? e.url : "${e.url}/");
    } else {
      setState(() {
        if (_selected.containsKey(e.url)) {
          _selected.remove(e.url);
        } else {
          _selected[e.url] = e;
        }
      });
    }
  }

  bool get _canGoUp => _cwd.replaceAll(RegExp(r"/$"), "") != _davRoot;

  void _goUp() {
    if (!_canGoUp) return;
    final trimmed = _cwd.replaceAll(RegExp(r"/$"), "");
    final parent = trimmed.substring(0, trimmed.lastIndexOf("/") + 1);
    _list(parent);
  }

  Future<void> _import() async {
    if (_selected.isEmpty || _importing) return;
    final items = List<_NcEntry>.from(_selected.values);
    setState(() {
      _importing = true;
      _importDone = 0;
      _importTotal = items.length;
    });
    var ok = 0;
    try {
      final tmpDir = await getTemporaryDirectory();
      for (final e in items) {
        if (!mounted) return;
        try {
          final res = await http.get(
            Uri.parse(e.url),
            headers: {"Authorization": _basicAuth},
          );
          if (res.statusCode != 200) {
            if (!mounted) return;
            setState(() => _importDone++);
            continue;
          }
          final tmp = File("${tmpDir.path}/nc_${sha256.convert(utf8.encode(e.url))}_${e.name}");
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
          // Skip; continue.
        }
        if (!mounted) return;
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

  @override
  Widget build(BuildContext context) {
    final connected = _url != null && _user != null && _pass != null;
    return Scaffold(
      appBar: AppBar(
        title: const Text("Import from Nextcloud"),
        actions: [
          if (connected)
            TextButton(
              onPressed: _disconnect,
              child: const Text("Disconnect"),
            ),
        ],
      ),
      floatingActionButton: (!connected || _selected.isEmpty)
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
      body: _loadingCreds
          ? const Center(child: CircularProgressIndicator())
          : connected
              ? _buildBrowser()
              : _ConnectForm(onConnect: _connect, busy: _loading, error: _error),
    );
  }

  Widget _buildBrowser() {
    return Column(
      children: [
        if (_canGoUp)
          ListTile(
            leading: const Icon(Icons.arrow_upward),
            title: const Text(".."),
            onTap: _goUp,
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(_error!, style: const TextStyle(color: Colors.red)),
          ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _entries.isEmpty
                  ? const Center(child: Text("Empty folder."))
                  : ListView.builder(
                      itemCount: _entries.length,
                      itemBuilder: (context, i) {
                        final e = _entries[i];
                        if (e.isDir) {
                          return ListTile(
                            leading: const Icon(Icons.folder),
                            title: Text(e.name,
                                maxLines: 1, overflow: TextOverflow.ellipsis),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => _open(e),
                          );
                        }
                        final sel = _selected.containsKey(e.url);
                        return CheckboxListTile(
                          value: sel,
                          onChanged: (_) => _open(e),
                          secondary: Icon(_iconFor(e.mimeType)),
                          title: Text(e.name,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(e.sizeLabel),
                          controlAffinity: ListTileControlAffinity.trailing,
                        );
                      },
                    ),
        ),
      ],
    );
  }

  IconData _iconFor(String mime) {
    if (mime.startsWith("video/")) return Icons.movie_outlined;
    if (mime == "application/pdf") return Icons.picture_as_pdf_outlined;
    if (mime.startsWith("image/")) return Icons.image_outlined;
    return Icons.insert_drive_file_outlined;
  }
}

class _ConnectForm extends StatefulWidget {
  const _ConnectForm({required this.onConnect, required this.busy, this.error});
  final Future<void> Function(String url, String user, String pass) onConnect;
  final bool busy;
  final String? error;

  @override
  State<_ConnectForm> createState() => _ConnectFormState();
}

class _ConnectFormState extends State<_ConnectForm> {
  final _url = TextEditingController();
  final _user = TextEditingController();
  final _pass = TextEditingController();

  @override
  void dispose() {
    _url.dispose();
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text(
          "Connect your Nextcloud server. Create an app-password in "
          "Nextcloud → Settings → Security → Devices & sessions.",
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _url,
          keyboardType: TextInputType.url,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: "Server URL",
            hintText: "https://cloud.example.com",
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _user,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: "Username",
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _pass,
          obscureText: true,
          decoration: const InputDecoration(
            labelText: "App-password",
            border: OutlineInputBorder(),
          ),
        ),
        if (widget.error != null) ...[
          const SizedBox(height: 12),
          Text(widget.error!, style: const TextStyle(color: Colors.red)),
        ],
        const SizedBox(height: 20),
        FilledButton.icon(
          onPressed: widget.busy
              ? null
              : () => widget.onConnect(_url.text, _user.text, _pass.text),
          icon: widget.busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.link),
          label: Text(widget.busy ? "Connecting…" : "Connect"),
        ),
      ],
    );
  }
}

class _NcEntry {
  _NcEntry({
    required this.name,
    required this.url,
    required this.isDir,
    required this.mimeType,
    required this.sizeBytes,
  });

  final String name;
  final String url;
  final bool isDir;
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
}
