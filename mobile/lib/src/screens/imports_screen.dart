// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5 (media import) — Imports screen (web parity for /app/imports).
//
// Mirrors the web import surface feature-for-feature:
//   - Connect Google Photos: the web uses a browser redirect; a native app
//     can't, so we use google_sign_in's offline-access flow (serverClientId +
//     drive.readonly) to obtain a one-time `serverAuthCode`, then POST it to
//     /api/v1/integrations/google/mobile-connect, which exchanges it for an
//     encrypted refresh token server-side. The tile reflects the connected /
//     needs-reconnect state from GET /api/v1/integrations.
//   - Import from Google Takeout: paste a Drive file ID of the Takeout archive
//     and kick a server-side import (matching the minimal web form).
//   - Import from Amazon Photos (.zip): pick a .zip via file_picker and stream
//     it to the raw-body upload endpoint.
//   - Imports list: polls GET /api/v1/imports every ~3s and renders per-job
//     progress, stopping once every job is terminal.
//
// This is complementary to GoogleDriveImportScreen (the on-device Drive file
// picker) — that flow downloads files client-side; this one drives the
// server-side Takeout/Amazon importers.
//
// ⚠ serverClientId: google_sign_in needs the OAuth 2.0 *Web* client ID to mint
// a serverAuthCode (the value already in android/app/src/main/res/values/
// strings.xml as default_web_client_id). It's repeated here as a const because
// the offline-access serverAuthCode flow requires it to be passed to
// GoogleSignIn explicitly (the platform default is only used for ID tokens).

import "dart:async";
import "dart:io";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";

/// OAuth 2.0 Web client ID (Google Cloud Console). MUST match
/// android/app/src/main/res/values/strings.xml `default_web_client_id`.
const _kServerClientId =
    "YOUR_CLIENT_ID.apps.googleusercontent.com";

/// Read-only Drive scope — Takeout archives live in the user's Drive. Matches
/// lib/integrations/google.ts GOOGLE_SCOPES.
const _kDriveScope = "https://www.googleapis.com/auth/drive.readonly";

/// Module-level singleton so sign-in state survives screen push/pop. Requesting
/// `serverClientId` makes `signIn()` populate `serverAuthCode`.
final _connectSignIn = GoogleSignIn(
  scopes: [_kDriveScope],
  serverClientId: _kServerClientId,
);

const _pollInterval = Duration(seconds: 3);

class ImportsScreen extends StatefulWidget {
  const ImportsScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<ImportsScreen> createState() => _ImportsScreenState();
}

class _ImportsScreenState extends State<ImportsScreen> {
  List<Integration> _integrations = const [];
  List<ImportJob> _jobs = const [];
  bool _loading = true;

  bool _connecting = false;
  String? _connectError;

  final _driveFileIdController = TextEditingController();
  bool _takeoutBusy = false;
  String? _takeoutMsg;

  bool _uploadBusy = false;
  String? _uploadMsg;

  Timer? _pollTimer;

  Integration? get _googleIntegration {
    for (final i in _integrations) {
      if (i.provider == "google") return i;
    }
    return null;
  }

  bool get _googleConnected => _googleIntegration?.isActive ?? false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _driveFileIdController.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final integrations = await widget.client.getIntegrations();
      final jobs = await widget.client.listImports();
      if (!mounted) return;
      setState(() {
        _integrations = integrations;
        _jobs = jobs;
        _loading = false;
      });
      _schedulePoll();
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  // Re-arm the poll only while a job is non-terminal, so a finished list
  // quiesces instead of polling forever.
  void _schedulePoll() {
    _pollTimer?.cancel();
    if (_jobs.every((j) => j.isTerminal)) return;
    _pollTimer = Timer(_pollInterval, _pollOnce);
  }

  Future<void> _pollOnce() async {
    try {
      final jobs = await widget.client.listImports();
      if (!mounted) return;
      setState(() => _jobs = jobs);
    } catch (_) {
      // Transient error — keep the last list and try again on the next tick.
    }
    if (mounted) _schedulePoll();
  }

  Future<void> _connectGoogle() async {
    if (_connecting) return;
    setState(() {
      _connecting = true;
      _connectError = null;
    });
    try {
      // Force a fresh consent so Google reliably returns a serverAuthCode even
      // on reconnect (a silent re-auth omits it).
      await _connectSignIn.signOut();
      final account = await _connectSignIn.signIn();
      if (account == null) {
        if (mounted) setState(() => _connecting = false);
        return; // User cancelled.
      }
      final code = account.serverAuthCode;
      if (code == null || code.isEmpty) {
        throw Exception("No server auth code returned");
      }
      await widget.client.connectGoogle(code);
      if (!mounted) return;
      setState(() => _connecting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Google connected.")),
      );
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _connecting = false;
        _connectError = "Connect failed: $e";
      });
    }
  }

  Future<void> _startTakeout() async {
    if (_takeoutBusy) return;
    final id = _driveFileIdController.text.trim();
    if (id.isEmpty) return;
    setState(() {
      _takeoutBusy = true;
      _takeoutMsg = null;
    });
    try {
      await widget.client.startGoogleTakeoutImport(id);
      if (!mounted) return;
      _driveFileIdController.clear();
      setState(() {
        _takeoutBusy = false;
        _takeoutMsg = "Import started — watch its progress below.";
      });
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _takeoutBusy = false;
        _takeoutMsg = "Failed: $e";
      });
    }
  }

  Future<void> _uploadAmazonZip() async {
    if (_uploadBusy) return;
    setState(() {
      _uploadBusy = true;
      _uploadMsg = null;
    });
    try {
      final picked = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const ["zip"],
        withData: false,
      );
      final path = picked?.files.single.path;
      if (path == null) {
        if (mounted) setState(() => _uploadBusy = false);
        return; // User cancelled the picker.
      }
      final workspaceId = await widget.client.workspaceId();
      await widget.client.uploadAmazonZip(File(path), workspaceId);
      if (!mounted) return;
      setState(() {
        _uploadBusy = false;
        _uploadMsg = "Upload received — import started.";
      });
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _uploadBusy = false;
        _uploadMsg = "Upload failed: $e";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Imports")),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _buildGoogleTile(),
                  const SizedBox(height: 16),
                  _buildTakeoutCard(),
                  const SizedBox(height: 16),
                  _buildAmazonCard(),
                  const SizedBox(height: 16),
                  _buildJobsCard(),
                ],
              ),
            ),
    );
  }

  Widget _buildGoogleTile() {
    final integration = _googleIntegration;
    final needsReconnect = integration?.status == "needs_reconnect";
    final String subtitle;
    if (_googleConnected) {
      subtitle = "Connected. Import a Takeout archive below.";
    } else if (needsReconnect) {
      subtitle = "Reconnect needed — your Google access expired.";
    } else {
      subtitle = "Connect to import a Google Takeout archive from your Drive.";
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.photo_library_outlined),
                const SizedBox(width: 12),
                const Expanded(
                  child: Text(
                    "Connect Google Photos",
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                if (_googleConnected)
                  const Icon(Icons.check_circle, color: Colors.green, size: 20),
              ],
            ),
            const SizedBox(height: 6),
            Text(subtitle, style: const TextStyle(fontSize: 13)),
            if (_connectError != null) ...[
              const SizedBox(height: 8),
              Text(
                _connectError!,
                style: const TextStyle(color: Colors.red, fontSize: 12),
              ),
            ],
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _connecting ? null : _connectGoogle,
              icon: _connecting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(_googleConnected ? Icons.refresh : Icons.login),
              label: Text(
                _connecting
                    ? "Connecting…"
                    : _googleConnected
                        ? "Reconnect"
                        : needsReconnect
                            ? "Reconnect"
                            : "Connect Google",
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTakeoutCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Import from Google Takeout",
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Text(
              _googleConnected
                  ? "Paste the Google Drive file ID of your Takeout archive."
                  : "Connect Google above first.",
              style: const TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _driveFileIdController,
              enabled: _googleConnected && !_takeoutBusy,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: "Drive file ID",
                hintText: "1aBcD…",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed:
                  _googleConnected && !_takeoutBusy ? _startTakeout : null,
              child: Text(_takeoutBusy ? "Starting…" : "Start import"),
            ),
            if (_takeoutMsg != null) ...[
              const SizedBox(height: 8),
              Text(_takeoutMsg!, style: const TextStyle(fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildAmazonCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Import from Amazon Photos",
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            const Text(
              "Upload a .zip exported from Amazon Photos.",
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _uploadBusy ? null : _uploadAmazonZip,
              icon: _uploadBusy
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.upload_file),
              label: Text(_uploadBusy ? "Uploading…" : "Choose .zip & import"),
            ),
            if (_uploadMsg != null) ...[
              const SizedBox(height: 8),
              Text(_uploadMsg!, style: const TextStyle(fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildJobsCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Imports",
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            if (_jobs.isEmpty)
              const Text(
                "No imports yet.",
                style: TextStyle(fontSize: 13),
              )
            else
              ..._jobs.map(_buildJobRow),
          ],
        ),
      ),
    );
  }

  Widget _buildJobRow(ImportJob job) {
    final fraction = job.fraction;
    final processedLabel = job.itemsTotal > 0
        ? "${job.itemsProcessed} / ${job.itemsTotal} processed"
        : "${job.itemsProcessed} processed";
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  job.providerLabel,
                  style: const TextStyle(fontWeight: FontWeight.w500),
                ),
              ),
              Text(
                job.status,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: _statusColor(job.status),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: job.status == "completed" ? 1.0 : fraction,
              minHeight: 6,
              color: job.status == "failed" ? Colors.red : null,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            [
              processedLabel,
              if (job.itemsDeduped > 0) "${job.itemsDeduped} deduped",
              if (job.itemsFailed > 0) "${job.itemsFailed} failed",
            ].join("  •  "),
            style: const TextStyle(fontSize: 12),
          ),
          if (job.status == "failed" && job.error != null) ...[
            const SizedBox(height: 4),
            Text(
              job.error!,
              style: const TextStyle(fontSize: 12, color: Colors.red),
            ),
          ],
        ],
      ),
    );
  }

  Color? _statusColor(String status) {
    switch (status) {
      case "completed":
        return Colors.green;
      case "failed":
        return Colors.red;
      default:
        return null;
    }
  }
}
