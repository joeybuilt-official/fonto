// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Google Photos import — Photos Picker API.
//
// Google retired the broad photoslibrary.readonly scope for third-party apps
// (Mar 2025). The replacement is the user-mediated Picker API: the app never
// lists the library; instead the user picks items in Google's own UI and we
// import exactly those.
//
// Flow:
//   1. Sign in (google_sign_in) for the photospicker.mediaitems.readonly scope.
//   2. POST /v1/sessions → { pickerUri, pollingConfig, mediaItemsSet }.
//   3. Open pickerUri (external browser / Google Photos app); user picks + Done.
//   4. Poll GET /v1/sessions/{id} until mediaItemsSet == true.
//   5. GET /v1/mediaItems?sessionId=… (paginated) → the picked items.
//   6. Download each baseUrl (=d photo / =dv video) WITH the OAuth Bearer
//      (required by the Picker API, unlike the old Library baseUrls), hash,
//      and enqueue through the existing UploadQueue → drain path.
//   7. DELETE /v1/sessions/{id}.
//
// ⚠ Operator gate (Google Cloud console, one-time):
//   1. Enable the "Photos Picker API" in the project.
//   2. On the OAuth consent screen add the scope
//      https://www.googleapis.com/auth/photospicker.mediaitems.readonly
//      (keep the app in Testing with your account as a test user — no
//      verification needed for the picker scope).
//   The Android + web OAuth clients are already configured (sign-in works).

import "dart:convert";
import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:crypto/crypto.dart";
import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";
import "package:url_launcher/url_launcher.dart";

import "../state/upload_queue.dart";

const _kPickerApiBase = "https://photospicker.googleapis.com/v1";
const _kPickerScope =
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

// Module-level singleton so the sign-in state survives screen push/pop.
final _gSignIn = GoogleSignIn(scopes: [_kPickerScope]);

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

enum _Phase { signIn, idle, picking, review, importing }

class _GooglePhotosImportScreenState extends State<GooglePhotosImportScreen> {
  GoogleSignInAccount? _gUser;
  bool _signingIn = false;
  String? _error;

  _Phase _phase = _Phase.signIn;

  // Active picker session.
  String? _sessionId;
  Duration _pollInterval = const Duration(seconds: 5);
  bool _polling = false;

  // Picked items + import progress.
  List<_GpItem> _items = [];
  int _importDone = 0;
  int _importTotal = 0;

  @override
  void initState() {
    super.initState();
    _tryRestoreSession();
  }

  @override
  void dispose() {
    // Best-effort: release any open picker session.
    final id = _sessionId;
    if (id != null) _deleteSession(id);
    super.dispose();
  }

  Future<void> _tryRestoreSession() async {
    setState(() => _signingIn = true);
    try {
      final user = await _gSignIn.signInSilently();
      if (!mounted) return;
      setState(() {
        _gUser = user;
        _signingIn = false;
        _phase = user != null ? _Phase.idle : _Phase.signIn;
      });
    } catch (_) {
      if (mounted) setState(() => _signingIn = false);
    }
  }

  Future<void> _signIn() async {
    setState(() {
      _signingIn = true;
      _error = null;
    });
    try {
      final user = await _gSignIn.signIn();
      if (!mounted) return;
      if (user == null) {
        setState(() => _signingIn = false); // cancelled
        return;
      }
      setState(() {
        _gUser = user;
        _signingIn = false;
        _phase = _Phase.idle;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _signingIn = false;
        _error = e.toString();
      });
    }
  }

  Future<String?> _token() async {
    final auth = await _gUser?.authentication;
    return auth?.accessToken;
  }

  Map<String, String> _authHeaders(String token) => {
        "Authorization": "Bearer $token",
      };

  // ── Picker session ────────────────────────────────────────────────────────

  Future<void> _startPicking() async {
    setState(() => _error = null);
    final token = await _token();
    if (token == null) {
      setState(() => _error = "Not signed in.");
      return;
    }
    try {
      final res = await http.post(
        Uri.parse("$_kPickerApiBase/sessions"),
        headers: {..._authHeaders(token), "Content-Type": "application/json"},
        body: "{}",
      );
      if (!mounted) return;
      if (res.statusCode != 200) {
        setState(() => _error =
            "Couldn't start a picker session (${res.statusCode}). Is the Photos Picker API enabled?");
        return;
      }
      final j = json.decode(res.body) as Map<String, dynamic>;
      final pickerUri = j["pickerUri"] as String?;
      _sessionId = j["id"] as String?;
      _pollInterval = _parseDuration(
        (j["pollingConfig"] as Map<String, dynamic>?)?["pollInterval"],
        fallback: const Duration(seconds: 5),
      );
      if (pickerUri == null || _sessionId == null) {
        setState(() => _error = "Picker session response was incomplete.");
        return;
      }
      final launched = await launchUrl(
        Uri.parse(pickerUri),
        mode: LaunchMode.externalApplication,
      );
      if (!launched) {
        setState(() => _error = "Couldn't open Google Photos.");
        return;
      }
      setState(() => _phase = _Phase.picking);
      _pollUntilPicked();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _pollUntilPicked() async {
    if (_polling) return;
    _polling = true;
    final id = _sessionId;
    if (id == null) {
      _polling = false;
      return;
    }
    final deadline = DateTime.now().add(const Duration(minutes: 10));
    try {
      while (mounted && _phase == _Phase.picking) {
        await Future<void>.delayed(_pollInterval);
        if (!mounted || _phase != _Phase.picking) return;
        if (DateTime.now().isAfter(deadline)) {
          setState(() => _error =
              "Timed out waiting for your selection. Tap to try again.");
          setState(() => _phase = _Phase.idle);
          return;
        }
        final token = await _token();
        if (token == null) return;
        final res = await http.get(
          Uri.parse("$_kPickerApiBase/sessions/$id"),
          headers: _authHeaders(token),
        );
        if (!mounted) return;
        if (res.statusCode != 200) continue; // transient; keep polling
        final j = json.decode(res.body) as Map<String, dynamic>;
        if (j["mediaItemsSet"] == true) {
          await _loadPickedItems(id);
          return;
        }
      }
    } finally {
      _polling = false;
    }
  }

  Future<void> _loadPickedItems(String sessionId) async {
    final out = <_GpItem>[];
    String? pageToken;
    try {
      final token = await _token();
      if (token == null) return;
      do {
        final uri = Uri.parse(
          "$_kPickerApiBase/mediaItems?sessionId=$sessionId&pageSize=100"
          "${pageToken != null ? "&pageToken=$pageToken" : ""}",
        );
        final res = await http.get(uri, headers: _authHeaders(token));
        if (res.statusCode != 200) break;
        final j = json.decode(res.body) as Map<String, dynamic>;
        final items = (j["mediaItems"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(_GpItem.fromJson)
            .where((it) => it.baseUrl.isNotEmpty)
            .toList();
        out.addAll(items);
        pageToken = j["nextPageToken"] as String?;
      } while (pageToken != null);
    } catch (_) {
      // fall through with whatever we collected
    }
    if (!mounted) return;
    setState(() {
      _items = out;
      _phase = _Phase.review;
    });
  }

  Future<void> _deleteSession(String id) async {
    try {
      final token = await _token();
      if (token == null) return;
      await http.delete(
        Uri.parse("$_kPickerApiBase/sessions/$id"),
        headers: _authHeaders(token),
      );
    } catch (_) {
      // best-effort
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────

  Future<void> _import() async {
    if (_items.isEmpty || _phase == _Phase.importing) return;
    final items = List<_GpItem>.from(_items);
    setState(() {
      _phase = _Phase.importing;
      _importDone = 0;
      _importTotal = items.length;
    });

    int ok = 0;
    try {
      final tmpDir = await getTemporaryDirectory();
      for (final item in items) {
        if (!mounted) return;
        try {
          final token = await _token();
          if (token == null) break;
          // Picker baseUrls REQUIRE the Bearer token (unlike old Library API).
          final dlUrl = item.isVideo ? "${item.baseUrl}=dv" : "${item.baseUrl}=d";
          final res = await http.get(
            Uri.parse(dlUrl),
            headers: _authHeaders(token),
          );
          if (res.statusCode != 200) {
            if (!mounted) return;
            setState(() => _importDone++);
            continue;
          }
          final fname =
              item.filename.isNotEmpty ? item.filename : "${item.id}.jpg";
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
          // skip; continue
        }
        if (!mounted) return;
        setState(() => _importDone++);
      }
      await UploadQueue.drain();
    } finally {
      final id = _sessionId;
      if (id != null) await _deleteSession(id);
      _sessionId = null;
    }

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("Queued $ok / ${items.length} for upload to Fonto.")),
    );
    Navigator.of(context).pop(ok > 0);
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Import from Google Photos"),
        actions: [
          if (_phase == _Phase.review && _items.isNotEmpty)
            TextButton(
              onPressed: _import,
              child: Text("Import (${_items.length})"),
            ),
        ],
      ),
      body: _signingIn ? const Center(child: CircularProgressIndicator()) : _body(),
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.signIn:
        return _SignInPrompt(error: _error, onSignIn: _signIn);
      case _Phase.idle:
        return _PickPrompt(error: _error, onPick: _startPicking);
      case _Phase.picking:
        return _PickingWait(onCheckNow: _pollUntilPicked, onCancel: _cancelPicking);
      case _Phase.review:
        return _ReviewGrid(items: _items, token: _token, onRepick: _startPicking);
      case _Phase.importing:
        return _ImportProgress(done: _importDone, total: _importTotal);
    }
  }

  void _cancelPicking() {
    final id = _sessionId;
    if (id != null) _deleteSession(id);
    _sessionId = null;
    setState(() => _phase = _Phase.idle);
  }

  static Duration _parseDuration(dynamic raw, {required Duration fallback}) {
    // Protobuf duration strings look like "5s" or "1.500s".
    if (raw is String && raw.endsWith("s")) {
      final secs = double.tryParse(raw.substring(0, raw.length - 1));
      if (secs != null && secs > 0) {
        return Duration(milliseconds: (secs * 1000).round());
      }
    }
    return fallback;
  }
}

// ── Sign-in prompt ──────────────────────────────────────────────────────────

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
              "Connect Google Photos. You'll pick the photos to import in "
              "Google's own picker, then we'll bring them into Fonto.",
              textAlign: TextAlign.center,
            ),
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                  textAlign: TextAlign.center),
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

// ── Pick prompt (signed in, no active session) ──────────────────────────────

class _PickPrompt extends StatelessWidget {
  const _PickPrompt({required this.error, required this.onPick});
  final String? error;
  final VoidCallback onPick;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.add_photo_alternate_outlined, size: 64),
            const SizedBox(height: 16),
            const Text(
              "Open Google Photos to choose the photos and videos you want to "
              "import. When you tap Done there, come back here.",
              textAlign: TextAlign.center,
            ),
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                  textAlign: TextAlign.center),
            ],
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onPick,
              icon: const Icon(Icons.photo_library),
              label: const Text("Pick in Google Photos"),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Waiting for the user to finish picking ──────────────────────────────────

class _PickingWait extends StatelessWidget {
  const _PickingWait({required this.onCheckNow, required this.onCancel});
  final Future<void> Function() onCheckNow;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 20),
            const Text(
              "Waiting for your selection in Google Photos…\n"
              "Pick your photos there, tap Done, then return to Fonto.",
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            OutlinedButton(
              onPressed: () => onCheckNow(),
              child: const Text("Check now"),
            ),
            TextButton(onPressed: onCancel, child: const Text("Cancel")),
          ],
        ),
      ),
    );
  }
}

// ── Review picked items before import ───────────────────────────────────────

class _ReviewGrid extends StatelessWidget {
  const _ReviewGrid({
    required this.items,
    required this.token,
    required this.onRepick,
  });
  final List<_GpItem> items;
  final Future<String?> Function() token;
  final VoidCallback onRepick;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text("No photos were selected."),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRepick, child: const Text("Pick again")),
          ],
        ),
      );
    }
    return FutureBuilder<String?>(
      future: token(),
      builder: (ctx, snap) {
        final headers = snap.data != null
            ? {"Authorization": "Bearer ${snap.data}"}
            : <String, String>{};
        return GridView.builder(
          padding: const EdgeInsets.all(4),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            crossAxisSpacing: 4,
            mainAxisSpacing: 4,
          ),
          itemCount: items.length,
          itemBuilder: (ctx, i) {
            final it = items[i];
            return Stack(
              fit: StackFit.expand,
              children: [
                CachedNetworkImage(
                  imageUrl: "${it.baseUrl}=w240-h240-c",
                  httpHeaders: headers,
                  fit: BoxFit.cover,
                  errorWidget: (_, __, ___) =>
                      const ColoredBox(color: Colors.black12, child: Icon(Icons.image)),
                ),
                if (it.isVideo)
                  const Positioned(
                    right: 4,
                    bottom: 4,
                    child: Icon(Icons.videocam, color: Colors.white, size: 18),
                  ),
              ],
            );
          },
        );
      },
    );
  }
}

// ── Import progress ─────────────────────────────────────────────────────────

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
          CircularProgressIndicator(value: total > 0 ? done / total : null),
          const SizedBox(height: 16),
          Text("Downloading $done / $total",
              style: Theme.of(context).textTheme.titleMedium),
        ],
      ),
    );
  }
}

// ── Model ─────────────────────────────────────────────────────────────────

class _GpItem {
  _GpItem({
    required this.id,
    required this.baseUrl,
    required this.mimeType,
    required this.filename,
    required this.isVideo,
  });

  final String id;
  final String baseUrl;
  final String mimeType;
  final String filename;
  final bool isVideo;

  factory _GpItem.fromJson(Map<String, dynamic> j) {
    final mediaFile = (j["mediaFile"] as Map<String, dynamic>?) ?? const {};
    final mime = (mediaFile["mimeType"] as String?) ?? "";
    final type = (j["type"] as String?) ?? "";
    return _GpItem(
      id: (j["id"] as String?) ?? "",
      baseUrl: (mediaFile["baseUrl"] as String?) ?? "",
      mimeType: mime,
      filename: (mediaFile["filename"] as String?) ?? "",
      isVideo: type == "VIDEO" || mime.startsWith("video/"),
    );
  }
}
