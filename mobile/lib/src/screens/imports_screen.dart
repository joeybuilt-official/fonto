// SPDX-License-Identifier: MIT
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

import "package:flutter/material.dart";
import "package:google_sign_in/google_sign_in.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "amazon_import_screen.dart";
import "takeout_import_screen.dart";

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
  const ImportsScreen({super.key, required this.client, this.provider});

  final FontoClient client;

  /// When set ("google" | "amazon"), the screen shows ONLY that provider's
  /// import flow — so Settings can offer them as two separate entries instead
  /// of one combined hub. null shows both (the legacy bundled view).
  final String? provider;

  @override
  State<ImportsScreen> createState() => _ImportsScreenState();
}

class _ImportsScreenState extends State<ImportsScreen> {
  List<Integration> _integrations = const [];
  List<ImportJob> _jobs = const [];
  bool _loading = true;

  bool _connecting = false;
  String? _connectError;

  Timer? _pollTimer;

  Integration? get _googleIntegration {
    for (final i in _integrations) {
      if (i.provider == "google") return i;
    }
    return null;
  }

  bool get _googleConnected => _googleIntegration?.isActive ?? false;

  bool get _showGoogle => widget.provider == null || widget.provider == "google";
  bool get _showAmazon => widget.provider == null || widget.provider == "amazon";

  String get _screenTitle => widget.provider == "google"
      ? "Google Takeout"
      : widget.provider == "amazon"
          ? "Amazon Photos"
          : "Imports";

  /// Jobs to show — scoped to the active provider so the Google screen doesn't
  /// list Amazon imports and vice-versa.
  List<ImportJob> get _visibleJobs {
    final p = widget.provider;
    if (p == null) return _jobs;
    final want = p == "google" ? "google-takeout" : "amazon-photos";
    return _jobs.where((j) => j.provider == want).toList();
  }

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _openImporter(Widget screen) async {
    final started = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => screen),
    );
    if (started == true && mounted) await _refresh();
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_screenTitle)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_showGoogle) ...[
                    _buildGoogleTile(),
                    const SizedBox(height: 16),
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.cloud_outlined),
                        title: const Text("Import from Google Takeout"),
                        subtitle: const Text(
                            "Import a Takeout archive from your Drive."),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => _openImporter(
                          TakeoutImportScreen(
                            client: widget.client,
                            googleConnected: _googleConnected,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (_showAmazon) ...[
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.photo_album_outlined),
                        title: const Text("Import from Amazon Photos"),
                        subtitle: const Text(
                            "Upload a ZIP exported from Amazon Photos."),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => _openImporter(
                            AmazonImportScreen(client: widget.client)),
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
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
                Expanded(
                  child: Text(
                    "Connect Google Photos",
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (_googleConnected)
                  Icon(
                    Icons.check_circle,
                    color: Theme.of(context).colorScheme.primary,
                    size: 20,
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(subtitle, style: Theme.of(context).textTheme.bodyMedium),
            if (_connectError != null) ...[
              const SizedBox(height: 8),
              Text(
                _connectError!,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.error,
                    ),
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

  Widget _buildJobsCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "Imports",
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            if (_visibleJobs.isEmpty)
              Text(
                "No imports yet.",
                style: Theme.of(context).textTheme.bodyMedium,
              )
            else
              ..._visibleJobs.map(_buildJobRow),
          ],
        ),
      ),
    );
  }

  Widget _buildJobRow(ImportJob job) {
    final theme = Theme.of(context);
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
                  style: theme.textTheme.titleSmall,
                ),
              ),
              Text(
                job.status,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: _statusColor(context, job.status),
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
              color: job.status == "failed" ? theme.colorScheme.error : null,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            [
              processedLabel,
              if (job.itemsDeduped > 0) "${job.itemsDeduped} deduped",
              if (job.itemsFailed > 0) "${job.itemsFailed} failed",
            ].join("  •  "),
            style: theme.textTheme.bodySmall,
          ),
          if (job.status == "failed" && job.error != null) ...[
            const SizedBox(height: 4),
            Text(
              job.error!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// `completed` (green) has no direct MD3 ColorScheme role — Material's
  /// guidance is to use a custom success token, which we don't have yet.
  /// `tertiary` is the closest non-error accent in the seeded palette so
  /// "completed" reads positive against the rest of the surface. Failures
  /// map to `error` so they share the destructive vocabulary.
  Color? _statusColor(BuildContext ctx, String status) {
    final scheme = Theme.of(ctx).colorScheme;
    switch (status) {
      case "completed":
        return scheme.tertiary;
      case "failed":
        return scheme.error;
      default:
        return null;
    }
  }
}
