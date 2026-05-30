// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Post-login landing. Stats bar + paginated asset grid w/
// pull-to-refresh + infinite scroll. Drawer = folder rail.
// AppBar search icon → SearchScreen. FAB → camera capture → upload.

import "dart:async";
import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter_doc_scanner/flutter_doc_scanner.dart";
import "package:image_picker/image_picker.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../state/auth_store.dart";
import "../state/drive_download_queue.dart";
import "../state/upload_queue.dart";
import "asset_detail_screen.dart";
import "settings_screen.dart";
import "../state/camera_roll_scanner.dart";
import "../state/push_notifications.dart";
import "../state/settings_store.dart";

const _kPageSize = 60;

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, required this.onSignOut});

  final AuthStore auth;
  final VoidCallback onSignOut;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late final FontoClient _client = FontoClient(widget.auth);
  final _picker = ImagePicker();
  final _scroll = ScrollController();

  bool _loadingFirst = true;
  bool _loadingMore = false;
  String? _error;
  WorkspaceStats? _stats;
  FolderTree? _tree;
  final List<Asset> _assets = [];
  final Map<String, String> _thumbs = {};
  AssetCursor? _cursor;
  bool _uploading = false;
  Timer? _processingPoll;
  // Full-library month buckets for the scrubber's domain. Refreshed any time
  // the asset grid is refreshed; null while the first load is still pending.
  List<AssetBucket> _buckets = const [];

  /// `null` → workspace root view (all assets, no filter).
  /// Otherwise filters via directoryPathPrefix.
  String? _folder;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_maybeLoadMore);
    // Refresh the queue badge whenever a drain ends (progress → null) so the
    // count reflects what actually uploaded without waiting for an event.
    UploadQueue.progress.addListener(_onUploadProgress);
    DriveDownloadQueue.pending.addListener(_onDrivePendingChange);
    _refresh();
    // Cold launch: push any existing backlog. The background WorkManager task
    // is heavily throttled by Android, and opening the app previously only
    // drained when a camera-roll scan found NEW files — so a backlog could sit
    // untouched. A foreground drain is the most reliable path and shows live
    // progress.
    _kickDrain();
    _maybeScanCameraRoll();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    UploadQueue.progress.removeListener(_onUploadProgress);
    DriveDownloadQueue.pending.removeListener(_onDrivePendingChange);
    _processingPoll?.cancel();
    _scroll.dispose();
    _client.close();
    super.dispose();
  }

  void _onUploadProgress() {
    if (UploadQueue.progress.value == null) _refreshQueueBadge();
  }

  /// Drive queue emptied — kick a drain so any freshly-uploaded assets land,
  /// then let _kickDrain call _softRefresh when the upload drain finishes.
  void _onDrivePendingChange() {
    if (!mounted) return;
    if (DriveDownloadQueue.pending.value == 0) _kickDrain();
  }

  /// Refresh the badge and kick a foreground drain. drain() requeues rows a
  /// killed background drain stranded `in_flight`, so this also recovers a
  /// wedged queue. Cheap no-op when nothing is pending. Fire-and-forget.
  void _kickDrain() {
    _refreshQueueBadge();
    UploadQueue.drain().then((n) {
      if (!mounted) return;
      _refreshQueueBadge();
      if (n > 0) _softRefresh();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _kickDrain();
  }

  /// While the server is still processing freshly-uploaded assets, poll the
  /// (cheap) stats endpoint so the "Processing N" banner ticks down. Self-
  /// cancels once nothing is processing and no upload is in flight, doing one
  /// final grid refresh to pull the now-ready thumbnails/classifications.
  void _ensureProcessingPoll() {
    if (_processingPoll != null) return;
    _processingPoll = Timer.periodic(const Duration(seconds: 6), (t) async {
      if (!mounted) {
        t.cancel();
        _processingPoll = null;
        return;
      }
      try {
        final s = await _client.stats();
        if (!mounted) return;
        setState(() => _stats = s);
        if (s.processing == 0 && UploadQueue.progress.value == null) {
          t.cancel();
          _processingPoll = null;
          _softRefresh();
        }
      } catch (_) {
        // Transient; keep polling.
      }
    });
  }

  void _maybeLoadMore() {
    if (!_scroll.hasClients) return;
    if (_scroll.position.pixels <
        _scroll.position.maxScrollExtent - 600) {
      return;
    }
    if (_loadingMore || _cursor == null) return;
    _loadMore();
  }

  /// Silently merge new assets into the grid without clearing it.
  /// Fetches the first page and prepends any IDs not already in _assets.
  /// Never shows the loading spinner — grid stays fully interactive.
  Future<void> _softRefresh() async {
    if (_loadingFirst) return;
    try {
      final stats = await _client.stats();
      final page = await _client.listAssets(
        limit: _kPageSize,
        directoryPathPrefix: _folder,
      );
      if (!mounted) return;
      final existingIds = {for (final a in _assets) a.id};
      final toAdd = page.assets.where((a) => !existingIds.contains(a.id)).toList();
      if (toAdd.isEmpty && stats.total == (_stats?.total ?? -1)) return;
      final newThumbs = toAdd.isEmpty
          ? <String, String>{}
          : await _client.assetUrls(
              toAdd.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _stats = stats;
        if (toAdd.isNotEmpty) {
          _assets.insertAll(0, toAdd);
          _thumbs.addAll(newThumbs);
        }
      });
      if (stats.processing > 0) _ensureProcessingPoll();
    } catch (_) {
      // Non-fatal — leave the visible grid as-is.
    }
  }

  Future<void> _refresh() async {
    setState(() {
      _loadingFirst = true;
      _error = null;
      _assets.clear();
      _thumbs.clear();
      _cursor = null;
    });
    try {
      // Tree + stats + scrubber buckets fetched once per refresh; not per-page.
      // assetBuckets() failure is non-fatal — the timeline still works, the
      // scrubber just doesn't render.
      final tree = await _client.folderTree();
      final stats = await _client.stats();
      final buckets = await _client.assetBuckets().catchError((_) => <AssetBucket>[]);
      final page = await _client.listAssets(
        limit: _kPageSize,
        directoryPathPrefix: _folder,
      );
      final thumbs = page.assets.isEmpty
          ? <String, String>{}
          : await _client.assetUrls(
              page.assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _stats = stats;
        _tree = tree;
        _buckets = buckets;
        _assets.addAll(page.assets);
        _thumbs.addAll(thumbs);
        _cursor = page.nextCursor;
        _loadingFirst = false;
      });
      if (stats.processing > 0) _ensureProcessingPoll();
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  Future<void> _loadMore() async {
    if (_cursor == null) return;
    setState(() => _loadingMore = true);
    try {
      final page = await _client.listAssets(
        limit: _kPageSize,
        after: _cursor,
        directoryPathPrefix: _folder,
      );
      final newThumbs = page.assets.isEmpty
          ? <String, String>{}
          : await _client.assetUrls(
              page.assets.map((a) => a.id).toList(),
              variant: "thumb",
            );
      if (!mounted) return;
      setState(() {
        _assets.addAll(page.assets);
        _thumbs.addAll(newThumbs);
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Load failed: ${e.status} ${e.message}")),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Load failed: $e")),
      );
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _error = msg;
      _loadingFirst = false;
    });
  }

  Future<void> _showAddSheet() async {
    // Quick-add sheet — fast paths only. Cloud imports (Google Drive,
    // Nextcloud, future Google Photos via the Picker API) live under
    // Settings → Import sources so they don't crowd the hot path.
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt),
              title: const Text("Take photo"),
              onTap: () => Navigator.pop(context, "photo"),
            ),
            ListTile(
              leading: const Icon(Icons.document_scanner),
              title: const Text("Scan document"),
              onTap: () => Navigator.pop(context, "scan"),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text("Pick from gallery"),
              onTap: () => Navigator.pop(context, "gallery"),
            ),
          ],
        ),
      ),
    );
    if (choice == "photo") await _captureAndUpload();
    if (choice == "scan") await _scanDocument();
    if (choice == "gallery") await _pickFromGallery();
  }

  Future<void> _pickFromGallery() async {
    final List<XFile> picked = await _picker.pickMultiImage();
    if (picked.isEmpty) return;
    setState(() => _uploading = true);
    int queued = 0;
    try {
      final queue = await UploadQueue.open();
      for (final x in picked) {
        try {
          final file = File(x.path);
          final hash = await UploadQueue.hashFile(file);
          final inserted = await queue.enqueue(
            filePath: file.path,
            virtualPath: _folder ?? "/",
            sha256Hex: hash,
          );
          if (inserted != null) queued++;
        } catch (_) {
          // Skip this one and keep going — partial success beats abort.
        }
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("Queued $queued of ${picked.length} for upload."),
        ),
      );
      await _refreshQueueBadge();
      final ok = await UploadQueue.drain();
      if (!mounted) return;
      await _refreshQueueBadge();
      if (ok > 0) await _softRefresh();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Enqueue failed: $e")),
      );
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _captureAndUpload() async {
    final picked = await _picker.pickImage(source: ImageSource.camera);
    if (picked == null) return;
    await _enqueueAndDrain(File(picked.path));
  }

  Future<void> _scanDocument() async {
    PdfScanResult? scan;
    try {
      scan = await FlutterDocScanner().getScannedDocumentAsPdf(page: 24);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Scan failed: $e")),
      );
      return;
    }
    if (scan == null) return; // user cancelled
    final path = _pdfPathFromUri(scan.pdfUri);
    if (path == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Scan produced an unreadable file.")),
      );
      return;
    }
    await _enqueueAndDrain(File(path));
  }

  // ML Kit returns a file:// URI into the app cache. Resolve to a real path
  // the queue can hash + read. content:// would need a platform-side copy we
  // don't have, so it's reported as unreadable rather than silently failing.
  String? _pdfPathFromUri(String pdfUri) {
    final uri = Uri.tryParse(pdfUri);
    if (uri == null || uri.scheme.isEmpty) return pdfUri;
    if (uri.scheme == "file") return uri.toFilePath();
    return null;
  }

  Future<void> _enqueueAndDrain(File file) async {
    setState(() => _uploading = true);
    try {
      final hash = await UploadQueue.hashFile(file);
      final queue = await UploadQueue.open();
      final inserted = await queue.enqueue(
        filePath: file.path,
        virtualPath: _folder ?? "/",
        sha256Hex: hash,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            inserted == null ? "Already queued." : "Queued for upload.",
          ),
        ),
      );
      await _refreshQueueBadge();
      // Foreground drain — quick win when the device is awake + online.
      // Workmanager keeps draining in the background even if we close.
      final ok = await UploadQueue.drain();
      if (!mounted) return;
      await _refreshQueueBadge();
      if (ok > 0) await _softRefresh();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Enqueue failed: $e")),
      );
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  int _queuedCount = 0;
  int _failedCount = 0;

  Future<void> _refreshQueueBadge() async {
    final q = await UploadQueue.open();
    final pending = await q.pendingCount();
    final failed = await q.failedCount();
    if (!mounted) return;
    setState(() {
      _queuedCount = pending;
      _failedCount = failed;
    });
  }

  Future<void> _showFailuresSheet() async {
    final q = await UploadQueue.open();
    final failures = await q.recentFailures();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetCtx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                child: Text(
                  "${failures.length} upload${failures.length == 1 ? "" : "s"} failed",
                  style: Theme.of(sheetCtx).textTheme.titleMedium,
                ),
              ),
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: failures.length,
                  itemBuilder: (_, i) {
                    final f = failures[i];
                    return ListTile(
                      dense: true,
                      leading: const Icon(Icons.error_outline, size: 20),
                      title: Text(
                        f.filePath.split("/").last,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        f.lastError ?? "Unknown error",
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    );
                  },
                ),
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () async {
                          final n = await q.clearFailed();
                          if (sheetCtx.mounted) Navigator.of(sheetCtx).pop();
                          await _refreshQueueBadge();
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text("Cleared $n failed upload${n == 1 ? "" : "s"}.")),
                            );
                          }
                        },
                        icon: const Icon(Icons.delete_outline),
                        label: const Text("Clear"),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () async {
                          final n = await q.retryFailed();
                          if (sheetCtx.mounted) Navigator.of(sheetCtx).pop();
                          await _refreshQueueBadge();
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text("Retrying $n upload${n == 1 ? "" : "s"}…")),
                            );
                          }
                          UploadQueue.drain().then((ok) {
                            if (!mounted) return;
                            _refreshQueueBadge();
                            if (ok > 0) _softRefresh();
                          });
                        },
                        icon: const Icon(Icons.refresh),
                        label: const Text("Retry all"),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _maybeScanCameraRoll() async {
    final enabled = await SettingsStore.getAutoImport();
    if (!enabled) return;
    final n = await CameraRollScanner.scanAndEnqueue();
    if (n > 0) {
      await _refreshQueueBadge();
      // Best-effort foreground drain; don't await so we don't block the grid.
      UploadQueue.drain().then((n) {
        if (!mounted) return;
        _refreshQueueBadge();
        if (n > 0) _softRefresh();
      });
    }
  }

  Future<void> _signOut() async {
    // Deregister the push token first — the DELETE needs the PAT still set.
    await PushNotifications.deregister(widget.auth);
    await widget.auth.clear();
    if (!mounted) return;
    widget.onSignOut();
  }

  Future<void> _openDetail(int i) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>?>(
      MaterialPageRoute(
        builder: (_) => AssetDetailScreen(
          client: _client,
          assets: _assets,
          initialIndex: i,
        ),
      ),
    );
    if (!mounted || result == null) return;
    // Detail popped w/ a trashed id — drop it from our local list so the
    // grid reflects the action without a full refresh.
    final trashedId = result["trashedId"] as String?;
    if (trashedId != null) {
      setState(() => _assets.removeWhere((a) => a.id == trashedId));
    }
  }

  void _selectFolder(String? folder) {
    Navigator.of(context).pop(); // close drawer
    if (folder == _folder) return;
    setState(() => _folder = folder);
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final title = _folder == null ? "Fonto" : _folder!;
    return Scaffold(
      appBar: AppBar(
        title: Text(title, overflow: TextOverflow.ellipsis),
        actions: [
          // Live upload-queue badge. During a foreground drain we show the
          // running remaining count straight off UploadQueue.progress so the
          // number visibly ticks down; otherwise the last-known pending count.
          ValueListenableBuilder<UploadProgress?>(
            valueListenable: UploadQueue.progress,
            builder: (context, prog, _) {
              final pending = prog != null ? prog.remaining : _queuedCount;
              if (pending == 0 && _failedCount == 0) {
                return const SizedBox.shrink();
              }
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Center(
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (pending > 0)
                        Chip(
                          avatar: prog != null
                              ? const SizedBox(
                                  width: 14,
                                  height: 14,
                                  child: CircularProgressIndicator(strokeWidth: 2),
                                )
                              : null,
                          label: Text("$pending ↑"),
                          visualDensity: VisualDensity.compact,
                          padding: EdgeInsets.zero,
                        ),
                      if (_failedCount > 0)
                        Padding(
                          padding: const EdgeInsets.only(left: 4),
                          child: ActionChip(
                            onPressed: _showFailuresSheet,
                            avatar: Icon(
                              Icons.error_outline,
                              size: 16,
                              color: Theme.of(context).colorScheme.error,
                            ),
                            label: Text("$_failedCount"),
                            visualDensity: VisualDensity.compact,
                            padding: EdgeInsets.zero,
                          ),
                        ),
                    ],
                  ),
                ),
              );
            },
          ),
        ],
      ),
      drawer: _AppDrawer(
        tree: _tree,
        selected: _folder,
        onSelect: _selectFolder,
        onSettings: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const SettingsScreen()),
        ),
        onSignOut: _signOut,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _uploading ? null : _showAddSheet,
        child: _uploading
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.add),
      ),
      body: Column(
        children: [
          _ProgressBanners(
            progress: UploadQueue.progress,
            processing: _stats?.processing ?? 0,
            downloadPending: DriveDownloadQueue.pending,
          ),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_loadingFirst) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 40),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: _refresh, child: const Text("Retry")),
            ],
          ),
        ),
      );
    }

    final groups = _groupAssetsByMonth(_assets);
    // O(1) lookup replaces the O(n) indexOf call that ran on every tile render,
    // which was causing a freeze on back-navigation from AssetDetailScreen.
    final flatIdxById = <String, int>{
      for (var i = 0; i < _assets.length; i++) _assets[i].id: i,
    };

    final scroll = RefreshIndicator(
      onRefresh: _refresh,
      child: CustomScrollView(
        controller: _scroll,
        slivers: [
          if (_stats != null && _folder == null)
            SliverToBoxAdapter(child: _StatsBar(stats: _stats!)),
          if (_assets.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Text("No assets yet. Tap + to add."),
              ),
            )
          else
            for (final g in groups) ...[
              SliverPersistentHeader(
                pinned: true,
                delegate: _MonthHeaderDelegate(
                  label: _monthLabel(g.month),
                  count: g.assets.length,
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
                sliver: SliverGrid(
                  gridDelegate:
                      const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 3,
                    crossAxisSpacing: 4,
                    mainAxisSpacing: 4,
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (context, i) {
                      final asset = g.assets[i];
                      return RepaintBoundary(
                        child: _AssetTile(
                          asset: asset,
                          url: _thumbs[asset.id],
                          onTap: () =>
                              _openDetail(flatIdxById[asset.id] ?? 0),
                        ),
                      );
                    },
                    childCount: g.assets.length,
                  ),
                ),
              ),
            ],
          if (_loadingMore)
            const SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              ),
            ),
        ],
      ),
    );

    // Scrubber overlay — full-library bucket-driven, drags through every
    // month in the workspace (not just the loaded pages). On release we hop
    // to the loaded-data offset of that month; if the month isn't loaded yet
    // we kick a few _loadMore() calls until it is.
    if (_buckets.length <= 1 || _assets.isEmpty) return scroll;
    return Stack(
      children: [
        scroll,
        Positioned(
          top: 4,
          right: 0,
          bottom: 4,
          width: 28,
          child: _TimelineScrubber(
            controller: _scroll,
            buckets: _buckets,
          ),
        ),
      ],
    );
  }

}

const double _kMonthHeaderHeight = 36;

// `num.clamp` returns num (not double) which the analyzer rejects in
// double-typed slots. This tiny helper keeps the call sites readable.
double _clampDouble(double v, double lo, double hi) =>
    v < lo ? lo : (v > hi ? hi : v);

/// "YYYY-MM" key from an asset, using captured-at when present so the
/// grouping matches the server's sort=captured ordering.
String _monthKey(Asset a) {
  final ts = a.capturedAt ?? a.createdAt;
  return "${ts.year.toString().padLeft(4, '0')}-"
      "${ts.month.toString().padLeft(2, '0')}";
}

String _monthLabel(String key) {
  if (key.length < 7) return key;
  final y = int.tryParse(key.substring(0, 4));
  final m = int.tryParse(key.substring(5, 7));
  if (y == null || m == null || m < 1 || m > 12) return key;
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return "${names[m - 1]} $y";
}

class _MonthGroup {
  _MonthGroup(this.month, this.assets);
  final String month;
  final List<Asset> assets;
}

List<_MonthGroup> _groupAssetsByMonth(List<Asset> assets) {
  if (assets.isEmpty) return const [];
  final out = <_MonthGroup>[];
  String? cur;
  List<Asset>? bucket;
  for (final a in assets) {
    final k = _monthKey(a);
    if (k != cur) {
      if (cur != null && bucket != null) out.add(_MonthGroup(cur, bucket));
      cur = k;
      bucket = <Asset>[];
    }
    bucket!.add(a);
  }
  if (cur != null && bucket != null) out.add(_MonthGroup(cur, bucket));
  return out;
}

class _MonthHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _MonthHeaderDelegate({required this.label, required this.count});
  final String label;
  final int count;

  @override
  double get minExtent => _kMonthHeaderHeight;

  @override
  double get maxExtent => _kMonthHeaderHeight;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    final theme = Theme.of(context);
    return Container(
      // Solid (not translucent) so the pinned header fully masks tiles
      // scrolling underneath — and avoids the deprecated withOpacity on
      // current stable Flutter, which fails `flutter analyze`.
      color: theme.scaffoldBackgroundColor,
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          Text(
            label,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            "· $count",
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }

  @override
  bool shouldRebuild(_MonthHeaderDelegate old) =>
      old.label != label || old.count != count;
}

/// Right-rail fast-scroll scrubber (Google/Apple-Photos style). No always-on
/// track — a pill thumb fades in while the list scrolls and fades out ~1.2s
/// after it settles. Drag the pill (or anywhere down the right edge) to
/// fast-scroll; a month/year bubble follows the finger.
class _TimelineScrubber extends StatefulWidget {
  const _TimelineScrubber({required this.controller, required this.buckets});
  final ScrollController controller;
  final List<AssetBucket> buckets;

  @override
  State<_TimelineScrubber> createState() => _TimelineScrubberState();
}

class _TimelineScrubberState extends State<_TimelineScrubber> {
  static const double _pillH = 44;

  double _frac = 0; // scroll position 0..1 — drives the pill's Y.
  bool _visible = false; // fades in on scroll, out when idle.
  bool _dragging = false;
  String? _bubbleMonth;
  Timer? _hideTimer;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onScroll);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onScroll);
    _hideTimer?.cancel();
    super.dispose();
  }

  void _onScroll() {
    if (!widget.controller.hasClients) return;
    final pos = widget.controller.position;
    final frac =
        pos.maxScrollExtent > 0 ? pos.pixels / pos.maxScrollExtent : 0.0;
    if (!mounted) return;
    setState(() {
      _frac = _clampDouble(frac, 0, 1);
      if (!_dragging) _visible = true;
    });
    _scheduleHide();
  }

  void _scheduleHide() {
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(milliseconds: 1200), () {
      if (mounted && !_dragging) setState(() => _visible = false);
    });
  }

  int _total() {
    int t = 0;
    for (final b in widget.buckets) {
      t += b.count;
    }
    return t;
  }

  String _monthAt(double fraction) {
    final total = _total();
    if (total == 0 || widget.buckets.isEmpty) {
      return widget.buckets.isEmpty ? "" : widget.buckets.first.month;
    }
    final target = (fraction * total).clamp(0, total - 1);
    int running = 0;
    for (final b in widget.buckets) {
      running += b.count;
      if (running > target) return b.month;
    }
    return widget.buckets.last.month;
  }

  void _seekToFraction(double frac) {
    if (!widget.controller.hasClients) return;
    widget.controller.jumpTo(
      _clampDouble(frac, 0, 1) * widget.controller.position.maxScrollExtent,
    );
  }

  void _onDrag(double localY, double height) {
    final frac = height > 0 ? _clampDouble(localY, 0, height) / height : 0.0;
    setState(() {
      _bubbleMonth = _monthAt(frac);
      _visible = true;
    });
    _seekToFraction(frac);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(
      builder: (context, c) {
        final height = c.maxHeight;
        final pillTop = _clampDouble(_frac * (height - _pillH), 0, height - _pillH);
        return GestureDetector(
          // translucent so plain taps on tiles near the right edge still pass
          // through; only vertical drags in this strip fast-scroll.
          behavior: HitTestBehavior.translucent,
          onVerticalDragStart: (d) {
            _hideTimer?.cancel();
            setState(() => _dragging = true);
            _onDrag(d.localPosition.dy, height);
          },
          onVerticalDragUpdate: (d) => _onDrag(d.localPosition.dy, height),
          onVerticalDragEnd: (_) {
            setState(() {
              _dragging = false;
              _bubbleMonth = null;
            });
            _scheduleHide();
          },
          child: Stack(
            children: [
              AnimatedPositioned(
                duration: const Duration(milliseconds: 80),
                top: pillTop,
                right: 6,
                child: AnimatedOpacity(
                  duration: const Duration(milliseconds: 200),
                  opacity: _visible || _dragging ? 1 : 0,
                  child: Container(
                    width: 8,
                    height: _pillH,
                    decoration: BoxDecoration(
                      color: scheme.primary,
                      borderRadius: BorderRadius.circular(4),
                      boxShadow: const [
                        BoxShadow(color: Colors.black26, blurRadius: 4),
                      ],
                    ),
                  ),
                ),
              ),
              if (_dragging && _bubbleMonth != null)
                Positioned(
                  right: 22,
                  top: _clampDouble(pillTop + _pillH / 2 - 16, 0, height - 32),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: scheme.inverseSurface,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      _monthLabel(_bubbleMonth!),
                      style: TextStyle(
                        color: scheme.onInverseSurface,
                        fontWeight: FontWeight.w600,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

/// Thin status strip above the grid: download bar, upload bar, server-processing line.
class _ProgressBanners extends StatelessWidget {
  const _ProgressBanners({
    required this.progress,
    required this.processing,
    required this.downloadPending,
  });

  final ValueListenable<UploadProgress?> progress;
  final int processing;
  final ValueListenable<int> downloadPending;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ValueListenableBuilder<int>(
      valueListenable: downloadPending,
      builder: (context, dlPending, _) {
        return ValueListenableBuilder<UploadProgress?>(
          valueListenable: progress,
          builder: (context, up, _) {
            final rows = <Widget>[];

            if (dlPending > 0) {
              rows.add(
                ValueListenableBuilder<bool>(
                  valueListenable: DriveDownloadQueue.importingAll,
                  builder: (context, isImportingAll, _) {
                    return ValueListenableBuilder<int>(
                      valueListenable: DriveDownloadQueue.totalEnqueued,
                      builder: (context, total, _) {
                        final label = isImportingAll
                            ? "Importing all Drive files…"
                              "${total > 0 ? ' ($total queued)' : ''}"
                            : "Downloading $dlPending Drive "
                              "${dlPending == 1 ? 'file' : 'files'}…";
                        return Container(
                          width: double.infinity,
                          color: scheme.tertiaryContainer,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 8),
                          child: Row(
                            children: [
                              SizedBox(
                                width: 14,
                                height: 14,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: scheme.onTertiaryContainer,
                                ),
                              ),
                              const SizedBox(width: 10),
                              Text(
                                label,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: scheme.onTertiaryContainer,
                                ),
                              ),
                            ],
                          ),
                        );
                      },
                    );
                  },
                ),
              );
            }

            if (up != null && up.total > 0) {
              rows.add(
                Container(
                  width: double.infinity,
                  color: scheme.primaryContainer,
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(Icons.cloud_upload_outlined,
                              size: 16, color: scheme.onPrimaryContainer),
                          const SizedBox(width: 8),
                          Text(
                            "Uploading ${up.done.clamp(0, up.total)} of ${up.total}",
                            style: TextStyle(
                              fontSize: 12,
                              color: scheme.onPrimaryContainer,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(3),
                        child: LinearProgressIndicator(
                          value: up.total == 0 ? null : up.done / up.total,
                          minHeight: 4,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }

            if (processing > 0) {
              rows.add(
                Container(
                  width: double.infinity,
                  color: scheme.secondaryContainer,
                  padding: const EdgeInsets.symmetric(
                      horizontal: 16, vertical: 8),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: scheme.onSecondaryContainer,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Text(
                        "Processing $processing "
                        "${processing == 1 ? 'item' : 'items'}…",
                        style: TextStyle(
                          fontSize: 12,
                          color: scheme.onSecondaryContainer,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }

            if (rows.isEmpty) return const SizedBox.shrink();
            return Column(mainAxisSize: MainAxisSize.min, children: rows);
          },
        );
      },
    );
  }
}

class _StatsBar extends StatelessWidget {
  const _StatsBar({required this.stats});
  final WorkspaceStats stats;

  @override
  Widget build(BuildContext context) {
    final pairs = <(String, int)>[
      ("Total", stats.total),
      ("Images", stats.images),
      ("Videos", stats.videos),
      ("Docs", stats.documents),
      ("★", stats.favorites),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: pairs
            .map((p) => Column(
                  children: [
                    Text(
                      "${p.$2}",
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      p.$1,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ],
                ))
            .toList(),
      ),
    );
  }
}

class _AssetTile extends StatelessWidget {
  const _AssetTile({
    required this.asset,
    required this.url,
    required this.onTap,
  });
  final Asset asset;
  final String? url;
  final VoidCallback onTap;

  bool get _isImage => asset.mimeType.startsWith("image/");
  bool get _isVideo => asset.mimeType.startsWith("video/");

  @override
  Widget build(BuildContext context) {
    final Widget media;
    if (url == null) {
      // No URL yet: images/videos get a neutral box; docs get the doc card.
      media = (_isImage || _isVideo)
          ? Container(color: Colors.black12)
          : _DocPlaceholder(asset: asset);
    } else if (_isImage || _isVideo) {
      media = Hero(
        tag: asset.id,
        child: CachedNetworkImage(
          imageUrl: url!,
          fit: BoxFit.cover,
          // Decode at grid-tile resolution to cap per-tile memory ~130×130px.
          memCacheWidth: 260,
          memCacheHeight: 260,
          placeholder: (_, __) => Container(color: Colors.black12),
          errorWidget: (_, __, ___) => const ColoredBox(
            color: Colors.black12,
            child: Icon(Icons.broken_image),
          ),
        ),
      );
    } else {
      // Documents: show the server-rendered first-page thumb when present,
      // otherwise a clean doc card — never a broken-image icon. (The urls
      // endpoint falls back to the original PDF when no thumb exists, which
      // can't decode as an image, so the errorWidget is the common path
      // until the thumbnail worker catches up.)
      media = Hero(
        tag: asset.id,
        child: CachedNetworkImage(
          imageUrl: url!,
          fit: BoxFit.cover,
          memCacheWidth: 260,
          memCacheHeight: 260,
          placeholder: (_, __) => _DocPlaceholder(asset: asset),
          errorWidget: (_, __, ___) => _DocPlaceholder(asset: asset),
        ),
      );
    }

    return GestureDetector(
      onTap: onTap,
      child: Stack(
        fit: StackFit.expand,
        children: [
          media,
          if (!_isImage)
            Positioned(
              left: 4,
              top: 4,
              child: _TypeBadge(
                icon: _isVideo
                    ? Icons.play_circle_fill
                    : Icons.description,
              ),
            ),
          if (asset.isProcessing)
            const Positioned(
              right: 4,
              bottom: 4,
              child: _ProcessingBadge(),
            ),
        ],
      ),
    );
  }
}

/// Corner spinner marking an asset the server is still ingesting
/// (classify / thumbnail / OCR). Mirrors the web grid's yellow pulse.
class _ProcessingBadge extends StatelessWidget {
  const _ProcessingBadge();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: Colors.black54,
        borderRadius: BorderRadius.circular(4),
      ),
      child: const SizedBox(
        width: 12,
        height: 12,
        child: CircularProgressIndicator(
          strokeWidth: 2,
          valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
        ),
      ),
    );
  }
}

/// Fallback card for document assets (or any non-image without a thumbnail).
/// Shows a doc icon, the file extension, and the filename so the user can
/// tell documents apart at a glance.
class _DocPlaceholder extends StatelessWidget {
  const _DocPlaceholder({required this.asset});
  final Asset asset;

  @override
  Widget build(BuildContext context) {
    final dot = asset.filename.lastIndexOf(".");
    final ext = dot > 0 && dot < asset.filename.length - 1
        ? asset.filename.substring(dot + 1).toUpperCase()
        : "DOC";
    return Container(
      color: const Color(0xFFECEAF4),
      padding: const EdgeInsets.all(6),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.description_outlined,
              size: 34, color: Colors.black54),
          const SizedBox(height: 4),
          Text(
            ext,
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 11,
              color: Colors.black54,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            asset.filename,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 10, color: Colors.black54),
          ),
        ],
      ),
    );
  }
}

/// Small corner chip marking videos (play) and documents (page).
class _TypeBadge extends StatelessWidget {
  const _TypeBadge({required this.icon});
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: Colors.black54,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Icon(icon, size: 16, color: Colors.white),
    );
  }
}

/// Mobile nav drawer. Always carries Home / Settings / Sign out so the
/// hamburger is useful even on a workspace with no folders; the folder list
/// only renders as a collapsible section when the /folders/tree response
/// has something to show. (Previously this was folder-only and went empty
/// on a flat library.)
class _AppDrawer extends StatelessWidget {
  const _AppDrawer({
    required this.tree,
    required this.selected,
    required this.onSelect,
    required this.onSettings,
    required this.onSignOut,
  });

  final FolderTree? tree;
  final String? selected;
  final ValueChanged<String?> onSelect;
  final VoidCallback onSettings;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final t = tree;
    return Drawer(
      child: SafeArea(
        child: ListView(
          children: [
            ListTile(
              leading: const Icon(Icons.home_outlined),
              title: const Text("Home"),
              selected: selected == null,
              onTap: () {
                Navigator.of(context).pop();
                onSelect(null);
              },
            ),
            ListTile(
              leading: const Icon(Icons.settings_outlined),
              title: const Text("Settings"),
              onTap: () {
                Navigator.of(context).pop();
                onSettings();
              },
            ),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text("Sign out"),
              onTap: () {
                Navigator.of(context).pop();
                onSignOut();
              },
            ),
            // Inline `t != null && …` so Dart's flow analysis promotes `t`
            // inside the spread body. Routing the check through an
            // intermediate bool local would lose the promotion and force `t!`
            // at every access.
            if (t != null && (t.paths.isNotEmpty || t.rootAssetCount > 0)) ...[
              const Divider(),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text(
                  "FOLDERS",
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.8,
                  ),
                ),
              ),
              if (t.rootAssetCount > 0)
                ListTile(
                  leading: const Icon(Icons.folder_outlined),
                  title: const Text("(root)"),
                  trailing: Text("${t.rootAssetCount}"),
                  selected: selected == "/",
                  onTap: () {
                    Navigator.of(context).pop();
                    onSelect("/");
                  },
                ),
              ...t.paths.map(
                (p) => ListTile(
                  leading: const Icon(Icons.folder),
                  title: Text(p.path, overflow: TextOverflow.ellipsis),
                  trailing: Text("${p.assetCount}"),
                  selected: selected == p.path,
                  onTap: () {
                    Navigator.of(context).pop();
                    onSelect(p.path);
                  },
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
