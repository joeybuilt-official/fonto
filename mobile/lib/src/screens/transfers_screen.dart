// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Transfers — a tap-through detail view for the three home-screen progress
// banners. Users were confused by the bare "Downloading / Uploading /
// Processing" strips: what's moving, from where, to where, and why are upload
// and download separate? This screen names each stage end-to-end and lets the
// user inspect (and retry) the queue behind each banner.
//
//   1. Downloads  — pulling files OUT of a connected cloud (Google Drive /
//                   Nextcloud) onto this device, staged for upload. Local
//                   SQLite queue (DriveDownloadQueue).
//   2. Uploads    — pushing this device's files INTO your Fonto account
//                   storage. Local SQLite queue (UploadQueue).
//   3. Processing — Fonto's servers analyzing what you uploaded (capture date,
//                   faces, thumbnails, screenshot-vs-photo). Runs server-side;
//                   we only show the live count from the stats endpoint.
//
// A Drive import does 1 → 2 → 3; a normal camera-roll backup is just 2 → 3.
import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../api/fonto_client.dart";
import "../state/auth_store.dart";
import "../state/drive_download_queue.dart";
import "../state/upload_queue.dart";
import "../theme/tokens.dart";
import "../widgets/list_states.dart";

class TransfersScreen extends StatefulWidget {
  const TransfersScreen({super.key});

  @override
  State<TransfersScreen> createState() => _TransfersScreenState();
}

class _TransfersScreenState extends State<TransfersScreen> {
  List<DriveDownloadEntry> _dlPending = const [];
  List<DriveDownloadEntry> _dlFailed = const [];
  List<UploadQueueEntry> _upPending = const [];
  List<UploadQueueEntry> _upFailed = const [];
  int _processing = 0;
  bool _loading = true;
  bool _busy = false;
  bool _error = false;

  // Debounce for the queue-tick refresh: progress ticks arrive rapidly during
  // an active upload, so we coalesce them instead of firing a reload per tick.
  Timer? _tickDebounce;
  // Slow poll for the networked stats() call — decoupled from the local-queue
  // refresh so a fast upload doesn't fire a network request per progress tick.
  Timer? _statsTimer;
  // Guards against overlapping local reloads racing their setState.
  bool _reloadInFlight = false;

  static const _statsPollInterval = Duration(seconds: 5);

  @override
  void initState() {
    super.initState();
    UploadQueue.progress.addListener(_onQueueTick);
    DriveDownloadQueue.pending.addListener(_onQueueTick);
    _statsTimer = Timer.periodic(_statsPollInterval, (_) => _refreshStats());
    _reload();
  }

  @override
  void dispose() {
    UploadQueue.progress.removeListener(_onQueueTick);
    DriveDownloadQueue.pending.removeListener(_onQueueTick);
    _tickDebounce?.cancel();
    _statsTimer?.cancel();
    super.dispose();
  }

  void _onQueueTick() {
    // A queue advanced in the background. Debounce so a burst of progress ticks
    // collapses into a single local refresh (no full-screen spinner, no stats
    // network call).
    _tickDebounce?.cancel();
    _tickDebounce = Timer(const Duration(milliseconds: 500), () {
      if (mounted) _reloadLocal();
    });
  }

  /// Full reload: local queues + a one-shot networked stats() read. Used on
  /// entry, pull-to-refresh, and Retry.
  Future<void> _reload({bool silent = false}) async {
    if (!silent && mounted) setState(() => _loading = true);
    final ok = await _reloadLocal();
    if (ok) await _refreshStats();
    if (!mounted) return;
    setState(() => _loading = false);
  }

  /// Refresh ONLY the local SQLite queues. Guarded (try/catch/finally) so a
  /// corrupt/locked queue surfaces a retryable error instead of leaving the
  /// screen stuck on a spinner. Returns true on success.
  Future<bool> _reloadLocal() async {
    if (_reloadInFlight) return !_error;
    _reloadInFlight = true;
    try {
      final dlQueue = await DriveDownloadQueue.open();
      final upQueue = await UploadQueue.open();
      final dlPending = await dlQueue.pendingItems();
      final dlFailed = await dlQueue.failures();
      final upPending = await upQueue.pendingItems();
      final upFailed = await upQueue.recentFailures();
      if (!mounted) return false;
      setState(() {
        _dlPending = dlPending;
        _dlFailed = dlFailed;
        _upPending = upPending;
        _upFailed = upFailed;
        _error = false;
      });
      return true;
    } catch (_) {
      if (mounted) setState(() => _error = true);
      return false;
    } finally {
      _reloadInFlight = false;
    }
  }

  /// Poll the networked processing count on its own slow cadence. Failures are
  /// non-fatal — the rest of the screen is local-only and still useful offline.
  Future<void> _refreshStats() async {
    int processing = _processing;
    try {
      final auth = await AuthStore.load();
      if (auth.isConfigured) {
        final client = FontoClient(auth);
        try {
          processing = (await client.stats()).processing;
        } finally {
          client.close();
        }
      }
    } catch (_) {
      return; // Offline / not signed in — keep the last value.
    }
    if (!mounted) return;
    setState(() => _processing = processing);
  }

  Future<void> _retryDownloads() async {
    HapticFeedback.mediumImpact();
    setState(() => _busy = true);
    try {
      final q = await DriveDownloadQueue.open();
      await q.retryFailed();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _reloadLocal();
  }

  Future<void> _clearDownloads() async {
    HapticFeedback.mediumImpact();
    setState(() => _busy = true);
    try {
      final q = await DriveDownloadQueue.open();
      await q.clearFailed();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _reloadLocal();
  }

  Future<void> _retryUploads() async {
    HapticFeedback.mediumImpact();
    setState(() => _busy = true);
    try {
      final q = await UploadQueue.open();
      await q.retryFailed();
      // Kick a drain so the retried rows start moving immediately.
      unawaited(UploadQueue.drain());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _reloadLocal();
  }

  Future<void> _clearUploads() async {
    HapticFeedback.mediumImpact();
    setState(() => _busy = true);
    try {
      final q = await UploadQueue.open();
      await q.clearFailed();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _reloadLocal();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Transfers")),
      body: _loading
          ? const _TransfersSkeleton()
          : _error
              ? ListErrorState(
                  onRetry: () => _reload(),
                  message:
                      "Couldn't read the transfer queue. Pull to refresh or retry.",
                )
              : RefreshIndicator(
              onRefresh: () => _reload(silent: true),
              child: ListView(
                children: [
                  const _IntroCard(),
                  _SectionCard(
                    icon: Icons.cloud_download_outlined,
                    title: "Downloads",
                    subtitle:
                        "Pulling files from a connected cloud (Google Drive, "
                        "Nextcloud) onto this device, then queuing them for "
                        "upload. Only runs during an import.",
                    pendingLabel: _dlPending.isEmpty
                        ? "Nothing downloading"
                        : "${_dlPending.length} waiting to download",
                    pending: [
                      for (final e in _dlPending)
                        _ItemRow(title: e.name, subtitle: e.virtualPath),
                    ],
                    failed: [
                      for (final e in _dlFailed)
                        _ItemRow(
                          title: e.name,
                          subtitle: e.error ?? "Failed",
                          failed: true,
                        ),
                    ],
                    failedCount: _dlFailed.length,
                    busy: _busy,
                    onRetry: _retryDownloads,
                    onClear: _clearDownloads,
                  ),
                  _SectionCard(
                    icon: Icons.cloud_upload_outlined,
                    title: "Uploads",
                    subtitle:
                        "Sending this device's files into your Fonto account "
                        "storage. Originals on your device are never moved or "
                        "deleted.",
                    pendingLabel: _upPending.isEmpty
                        ? "Nothing uploading"
                        : "${_upPending.length} waiting to upload",
                    pending: [
                      for (final e in _upPending)
                        _ItemRow(
                          title: _basename(e.filePath),
                          subtitle: e.state == "in_flight"
                              ? "Uploading…"
                              : e.virtualPath,
                        ),
                    ],
                    failed: [
                      for (final e in _upFailed)
                        _ItemRow(
                          title: _basename(e.filePath),
                          subtitle: e.lastError ?? "Failed",
                          failed: true,
                        ),
                    ],
                    failedCount: _upFailed.length,
                    busy: _busy,
                    onRetry: _retryUploads,
                    onClear: _clearUploads,
                  ),
                  _SectionCard(
                    icon: Icons.auto_awesome_outlined,
                    title: "Processing",
                    subtitle:
                        "Fonto's servers analyzing what you uploaded — capture "
                        "date, faces, thumbnails, photo vs. screenshot. This "
                        "finishes on its own; you can close the app.",
                    pendingLabel: _processing == 0
                        ? "Nothing processing"
                        : "$_processing item${_processing == 1 ? '' : 's'} "
                          "processing on Fonto",
                    pending: const [],
                    failed: const [],
                    failedCount: 0,
                    busy: _busy,
                    onRetry: null,
                    onClear: null,
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
    );
  }

  static String _basename(String path) {
    final i = path.lastIndexOf("/");
    return i < 0 ? path : path.substring(i + 1);
  }
}

class _IntroCard extends StatelessWidget {
  const _IntroCard();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        "A Drive import flows top to bottom: download from the cloud → upload "
        "to your library → process on Fonto. A normal phone backup skips the "
        "download step.",
        style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.pendingLabel,
    required this.pending,
    required this.failed,
    required this.failedCount,
    required this.busy,
    required this.onRetry,
    required this.onClear,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String pendingLabel;
  final List<Widget> pending;
  final List<Widget> failed;
  final int failedCount;
  final bool busy;
  final VoidCallback? onRetry;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: scheme.primary),
                const SizedBox(width: 10),
                Text(title,
                    style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 6),
            Text(subtitle,
                style: TextStyle(
                    fontSize: 12.5, color: scheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            Text(pendingLabel,
                style: const TextStyle(fontWeight: FontWeight.w600)),
            if (pending.isNotEmpty) ...[
              const SizedBox(height: 6),
              ...pending,
            ],
            if (failedCount > 0) ...[
              const Divider(height: 24),
              Row(
                children: [
                  Icon(Icons.error_outline,
                      size: 18, color: scheme.error),
                  const SizedBox(width: 8),
                  Text(
                    "$failedCount failed",
                    style: TextStyle(
                        color: scheme.error, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              ...failed,
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: (busy || onClear == null)
                        ? null
                        : () async {
                            final ok = await showDialog<bool>(
                              context: context,
                              builder: (ctx) => AlertDialog(
                                title: const Text("Clear failed items?"),
                                content: const Text(
                                    "Failed transfers will be removed from this list. This can't be undone."),
                                actions: [
                                  TextButton(
                                    onPressed: () =>
                                        Navigator.of(ctx).pop(false),
                                    child: const Text("Cancel"),
                                  ),
                                  FilledButton(
                                    onPressed: () =>
                                        Navigator.of(ctx).pop(true),
                                    child: const Text("Clear"),
                                  ),
                                ],
                              ),
                            );
                            if (ok == true) onClear!();
                          },
                    child: const Text("Clear"),
                  ),
                  const SizedBox(width: 4),
                  FilledButton.tonal(
                    onPressed: busy ? null : onRetry,
                    child: const Text("Retry all"),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Content-shaped loading placeholder for Transfers — three card-sized blocks
/// mirroring the Downloads / Uploads / Processing sections. Built from the
/// shared [imageSkeleton] surface token instead of a bare spinner.
class _TransfersSkeleton extends StatelessWidget {
  const _TransfersSkeleton();

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        Container(
          margin: const EdgeInsets.fromLTRB(
              FontoSpace.s4, FontoSpace.s4, FontoSpace.s4, FontoSpace.s2),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(FontoShape.medium),
            child: SizedBox(height: 56, child: imageSkeleton(context)),
          ),
        ),
        for (var i = 0; i < 3; i++)
          Container(
            margin: const EdgeInsets.fromLTRB(
                FontoSpace.s4, FontoSpace.s2, FontoSpace.s4, FontoSpace.s2),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(FontoShape.medium),
              child: SizedBox(height: 96, child: imageSkeleton(context)),
            ),
          ),
      ],
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({
    required this.title,
    required this.subtitle,
    this.failed = false,
  });

  final String title;
  final String subtitle;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            failed ? Icons.warning_amber_rounded : Icons.insert_drive_file_outlined,
            size: 16,
            color: failed ? scheme.error : scheme.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13),
                ),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 11, color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
