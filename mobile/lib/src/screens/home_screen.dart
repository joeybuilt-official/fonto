// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Post-login landing. Stats bar + paginated asset grid w/
// pull-to-refresh + infinite scroll. Drawer = folder rail.
// AppBar search icon → SearchScreen. FAB → camera capture → upload.

import "dart:async";
import "dart:io";

import "package:cached_network_image/cached_network_image.dart";
import "package:connectivity_plus/connectivity_plus.dart";
import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter_doc_scanner/flutter_doc_scanner.dart";
import "package:image_picker/image_picker.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../services/zip_export.dart";
import "../state/auth_store.dart";
import "../state/asset_cache.dart";
import "../state/offline_cache.dart";
import "../state/offline_prefetch.dart";
import "../state/pending_mutations.dart";
import "../state/drive_download_queue.dart";
import "../state/sync_service.dart";
import "../state/upload_queue.dart";
import "../widgets/list_states.dart";
import "../widgets/live_badge.dart";
import "asset_detail_screen.dart";
import "device_asset_viewer.dart";
import "files_surface.dart";
import "memories_screen.dart";
import "settings_screen.dart";
import "transfers_screen.dart";
import "../state/camera_roll_scanner.dart";
import "../state/device_photos.dart";
import "../state/device_kind.dart";
import "../state/push_notifications.dart";
import "../state/settings_store.dart";
import "package:photo_manager/photo_manager.dart";

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
  // Derived views of _assets, recomputed only when _assets actually mutates
  // (see _recomputeDerived). Re-deriving these O(n) passes on every setState —
  // including ones that don't touch _assets — froze the grid on large
  // libraries, especially on back-nav from AssetDetailScreen.
  List<Asset> _visible = const [];
  List<_MonthGroup> _groups = const [];
  Map<String, int> _flatIdxById = const {};
  final Map<String, String> _thumbs = {};
  AssetCursor? _cursor;
  // M8 — multi-select export. Long-press a tile to enter selection.
  bool _selecting = false;
  final Set<String> _selected = {};
  // Offline mode — the grid is being served from the on-device cache because
  // the network is unreachable. Drives the offline banner + cache pagination.
  bool _offline = false;
  int? _offBeforeTs;
  String? _offBeforeId;
  bool _offHasMore = false;
  bool _uploading = false;
  Timer? _processingPoll;
  // Re-run the offline prefetch when connectivity returns / the app resumes,
  // debounced so a burst of connectivity events (Wi-Fi handshake flapping)
  // only fires one pass.
  StreamSubscription<List<ConnectivityResult>>? _connSub;
  Timer? _prefetchDebounce;
  bool _wasOffline = false;
  // Full-library month buckets for the scrubber's domain. Refreshed any time
  // the asset grid is refreshed; null while the first load is still pending.
  List<AssetBucket> _buckets = const [];

  // Local camera-roll recents for the "On this device" section. Populated only
  // when photo access is already granted (we never prompt here). Shown above
  // the server grid while offline, or whenever auto-import is on and there are
  // device photos pending upload. These are purely local thumbnails — they
  // render with no network. Viewing them also enqueues them for upload via the
  // existing CameraRollScanner / UploadQueue path.
  List<AssetEntity> _devicePhotos = const [];

  // Per-entity KIND for the "On this device" strip, populated once the
  // recents list is known. Filters the strip by the active lens (Moments /
  // Screenshots / Graphics / Videos) so the device section respects the same
  // partition the server grid does. Keyed by AssetEntity.id.
  Map<String, String> _deviceKindById = const <String, String>{};

  /// `null` → workspace root view (all assets, no filter).
  /// Otherwise filters via directoryPathPrefix.
  String? _folder;

  /// Phase 7 — active lens (matches the web Library lens selector).
  /// "moment" is the default; "all" clears the kind filter; the rest map
  /// 1:1 to `?kind=` on /api/v1/assets.
  String _lens = "moment";

  // Photos-Files split (feature-flagged via /api/v1/config). When ON, the flat
  // lens row becomes a Photos/Files segmented control + an Inbox holding area
  // for unclassified assets. When OFF, every split field below is inert and the
  // grid behaves exactly as before. See plans/photos-vs-files-split/plan.md.
  bool _splitOn = false;
  String _surface = "photos"; // photos | files | unsorted
  String _splitLens = "all"; // surface-scoped lens (all + per-kind)
  int _unsortedCount = 0;

  bool get _isFiles => _splitOn && _surface == "files";
  bool get _isUnsorted => _splitOn && _surface == "unsorted";
  bool get _isPhotos => !_splitOn || _surface == "photos";

  /// `?kind=` value for the active (surface, lens). Comma list for the union
  /// "All" lenses; null for Inbox (uses `unclassified=1`) and the legacy "all".
  String? _effectiveKind() {
    if (!_splitOn) return _lens == "all" ? null : _lens;
    if (_surface == "unsorted") return null;
    if (_surface == "photos") {
      if (_splitLens == "moment") return "moment";
      if (_splitLens == "video") return "video";
      return "moment,video";
    }
    if (_splitLens == "screenshot") return "screenshot";
    if (_splitLens == "graphics") return "graphics";
    if (_splitLens == "document") return "document";
    return "screenshot,graphics,document";
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_maybeLoadMore);
    // Refresh the queue badge whenever a drain ends (progress → null) so the
    // count reflects what actually uploaded without waiting for an event.
    UploadQueue.progress.addListener(_onUploadProgress);
    DriveDownloadQueue.pending.addListener(_onDrivePendingChange);
    _bootstrap();
    // Re-run the offline prefetch (+ recover the grid) whenever connectivity
    // comes back. The metadata phase is what fills the cache so the next
    // offline open isn't blank.
    _connSub = Connectivity().onConnectivityChanged.listen(_onConnectivity);
    // Cold launch with a backlog of offline edits (favorite toggles made last
    // session, app reopened online): replay them now. No-op when empty/offline.
    _drainPendingMutations();
    // Cold launch: push any existing backlog. The background WorkManager task
    // is heavily throttled by Android, and opening the app previously only
    // drained when a camera-roll scan found NEW files — so a backlog could sit
    // untouched. A foreground drain is the most reliable path and shows live
    // progress.
    _kickDrain();
    _kickDriveDrain();
    _maybeScanCameraRoll();
    _loadSplitConfig();
  }

  /// Cold-start sequence optimized for instant first paint:
  ///   1. local camera-roll strip — no network, renders immediately;
  ///   2. cached server page — instant grid if we have one (stale-while-revalidate);
  ///   3. fresh server data in the background, which swaps in without blanking
  ///      what's already on screen.
  Future<void> _bootstrap() async {
    // Fire the local-photos load first so the "On this device" strip paints
    // before any network call resolves.
    unawaited(_maybeLoadDevicePhotos());
    final primed = await _primeFromCache();
    await _refresh(background: primed);
  }

  /// Paint the last-cached page instantly so the grid is never a blank spinner
  /// when we have something to show. Returns true when it rendered cached rows.
  Future<bool> _primeFromCache() async {
    try {
      final cache = await AssetCache.open();
      final cached =
          await cache.queryPage(folderPrefix: _folder, limit: _kPageSize);
      if (!mounted || cached.assets.isEmpty) return false;
      setState(() {
        _assets
          ..clear()
          ..addAll(cached.assets);
        _thumbs
          ..clear()
          ..addAll(cached.thumbs);
        _recomputeDerived();
        _loadingFirst = false;
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Read the Photos-Files split flag + last-used surface. Best-effort; on any
  /// failure the legacy lens row stays.
  Future<void> _loadSplitConfig() async {
    try {
      final flags = await _client.featureFlags();
      final on = flags["librarySurfaceSplit"] == true;
      final last = await SettingsStore.getLastSurface();
      if (!mounted) return;
      setState(() {
        _splitOn = on;
        if (on) _surface = last;
      });
      if (on) {
        _refreshUnsortedCount();
        // The legacy initial _refresh() ran with the old single-lens kind; when
        // the restored surface differs (Files/Inbox), refetch with split params.
        if (last != "photos") _refresh();
      }
    } catch (_) {
      // Leave legacy behaviour.
    }
  }

  Future<void> _refreshUnsortedCount() async {
    final n = await _client.inboxCount();
    if (mounted) setState(() => _unsortedCount = n);
  }

  Future<void> _setSurface(String s) async {
    if (_surface == s) return;
    setState(() {
      _surface = s;
      _splitLens = "all";
    });
    if (s == "photos" || s == "files") {
      await SettingsStore.setLastSurface(s);
    }
    // Files self-fetches via the FilesSurface widget; Photos/Inbox use the grid.
    if (s != "files") await _refresh();
    _refreshUnsortedCount();
  }

  void _setSplitLens(String lens) {
    if (_splitLens == lens) return;
    setState(() => _splitLens = lens);
    // Photos/Inbox grid needs a refetch; FilesSurface reacts via its widget
    // params (didUpdateWidget) on the rebuild this setState triggers.
    if (!_isFiles) _refresh();
  }

  /// Library header: the surface segmented control + Inbox banner + scoped lens
  /// chips when the split flag is on; otherwise the legacy flat lens row.
  Widget _libraryHeader() {
    if (_splitOn) {
      return _SurfaceSelector(
        surface: _surface,
        lens: _splitLens,
        unsortedCount: _unsortedCount,
        onSurface: _setSurface,
        onLens: _setSplitLens,
      );
    }
    return _LensSelector(active: _lens, onChange: _setLens);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    UploadQueue.progress.removeListener(_onUploadProgress);
    DriveDownloadQueue.pending.removeListener(_onDrivePendingChange);
    _processingPoll?.cancel();
    _prefetchDebounce?.cancel();
    _connSub?.cancel();
    _scroll.dispose();
    _client.close();
    super.dispose();
  }

  /// Connectivity changed. When we transition (back) onto a usable connection,
  /// debounce-kick the offline prefetch so the on-device cache stays warm, and
  /// — if the grid is currently showing the offline fallback — pull a fresh
  /// page so the user sees live content again.
  void _onConnectivity(List<ConnectivityResult> results) {
    final online = results.any((r) => r != ConnectivityResult.none);
    if (!online) {
      _wasOffline = true;
      return;
    }
    final cameBackOnline = _wasOffline || _offline;
    _wasOffline = false;
    _kickPrefetch();
    if (cameBackOnline && mounted) _refresh();
  }

  /// Debounced unawaited prefetch kick. OfflinePrefetch.run is itself
  /// idempotent + guarded against concurrent passes; the debounce just avoids
  /// scheduling a flurry on connectivity flap.
  void _kickPrefetch() {
    _prefetchDebounce?.cancel();
    _prefetchDebounce = Timer(const Duration(seconds: 2), () {
      OfflinePrefetch.run(widget.auth);
      // Replay any edits made offline (favorite toggles). Best-effort.
      _drainPendingMutations();
    });
  }

  Future<void> _drainPendingMutations() async {
    try {
      final q = await PendingMutations.open();
      final n = await q.drain(widget.auth);
      if (mounted && n > 0) _softRefresh();
    } catch (_) {
      // Best-effort — the next reconnect retries.
    }
  }

  void _onUploadProgress() {
    if (UploadQueue.progress.value == null) {
      _refreshQueueBadge();
      _softRefresh();
    }
  }

  /// Drive queue emptied — kick a drain so any freshly-uploaded assets land,
  /// then let _kickDrain call _softRefresh when the upload drain finishes.
  void _onDrivePendingChange() {
    if (!mounted) return;
    if (DriveDownloadQueue.pending.value == 0) {
      // Backlog cleared — freshly-downloaded files are now in the upload queue.
      _kickDrain();
    } else {
      // Items are still pending — make sure a foreground drain is running.
      _kickDriveDrain();
    }
  }

  /// Refresh the badge and kick a foreground drain. drain() requeues rows a
  /// killed background drain stranded `in_flight`, so this also recovers a
  /// wedged queue. Cheap no-op when nothing is pending. Fire-and-forget.
  void _kickDrain() {
    _refreshQueueBadge();
    // Start the background sync service so the drain survives the app being
    // backgrounded/closed. No-op when nothing is pending or already running.
    SyncService.ensureRunning();
    UploadQueue.drain().then((n) {
      if (!mounted) return;
      _refreshQueueBadge();
      _softRefresh();
    });
  }

  /// Foreground drain of the Drive download backlog. The home screen is the
  /// only always-mounted surface, so without this a backlog left by a closed
  /// import screen (or a throttled WorkManager task) would never download —
  /// the count just sits there. Re-entrancy is guarded inside the queue.
  /// Fire-and-forget; the `pending` ValueNotifier drives the banner.
  void _kickDriveDrain() {
    if (DriveDownloadQueue.pending.value == 0) return;
    SyncService.ensureRunning();
    DriveDownloadQueue.processForeground();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _kickDrain();
      _kickDriveDrain();
      // Resumed — refresh the offline cache in the background. Idempotent +
      // self-gated on connectivity, so it's a no-op offline.
      _kickPrefetch();
    }
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
    if (_loadingMore) return;
    if (_offline) {
      _loadMoreOffline();
      return;
    }
    if (_cursor == null) return;
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
        kind: _effectiveKind(),
        unclassified: _isUnsorted,
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
          _recomputeDerived();
        }
      });
      if (stats.processing > 0) _ensureProcessingPoll();
    } catch (_) {
      // Non-fatal — leave the visible grid as-is, but surface that the
      // refresh didn't land so the user knows the grid may be stale.
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Couldn't refresh — showing older items.")),
      );
    }
  }

  /// Pull fresh server data. Never blanks the grid: the spinner only shows on a
  /// truly empty cold start (`background` false AND nothing already rendered);
  /// otherwise the existing rows (cache-primed or prior) stay visible until the
  /// new page swaps in. The four top-level fetches are independent, so they run
  /// concurrently rather than in series.
  Future<void> _refresh({bool background = false}) async {
    setState(() {
      _error = null;
      if (!background && _assets.isEmpty) _loadingFirst = true;
    });
    try {
      // assetBuckets() failure is non-fatal — the timeline still works, the
      // scrubber just doesn't render.
      final results = await Future.wait<Object>([
        _client.folderTree(),
        _client.stats(),
        _client.assetBuckets().catchError((_) => <AssetBucket>[]),
        _client.listAssets(
          limit: _kPageSize,
          directoryPathPrefix: _folder,
          kind: _effectiveKind(),
          unclassified: _isUnsorted,
        ),
      ]);
      final tree = results[0] as FolderTree;
      final stats = results[1] as WorkspaceStats;
      final buckets = results[2] as List<AssetBucket>;
      final page = results[3] as AssetPage;
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
        _assets
          ..clear()
          ..addAll(page.assets);
        _thumbs
          ..clear()
          ..addAll(thumbs);
        _recomputeDerived();
        _cursor = page.nextCursor;
        _offline = false;
        _loadingFirst = false;
      });
      // Persist this page so the grid still renders next time the network is
      // down. Fire-and-forget — a cache write must never block the UI.
      unawaited(_persist(page.assets, thumbs));
      if (stats.processing > 0) _ensureProcessingPoll();
    } on ApiException catch (e) {
      await _fallbackToCache("${e.status}: ${e.message}");
    } catch (e) {
      await _fallbackToCache(e.toString());
    }
  }

  Future<void> _persist(List<Asset> assets, Map<String, String> thumbs) async {
    try {
      final cache = await AssetCache.open();
      await cache.upsertAll(assets, thumbs: thumbs);
    } catch (_) {
      // Cache write failure is non-fatal.
    }
  }

  /// True only when the device has no usable connectivity. The grid falls back
  /// to cached content on ANY API failure (500, auth flap, transient timeout),
  /// but the "Offline — showing your saved library" banner should fire ONLY
  /// when the phone is actually offline. Without this gate, a single server
  /// 5xx pinned the banner on even though the radio was happy, which is
  /// exactly what the operator reported on 2026-06-22.
  Future<bool> _isReallyOffline() async {
    try {
      final results = await Connectivity().checkConnectivity();
      return !results.any((r) => r != ConnectivityResult.none);
    } catch (_) {
      // Connectivity probe itself failed — fall back to the conservative
      // assumption that the network is up, so we don't lie to the user.
      return false;
    }
  }

  /// Network refresh failed — serve the first page from the on-device cache so
  /// the user isn't stranded with a blank grid. Falls through to the error
  /// state only when there's genuinely nothing cached.
  Future<void> _fallbackToCache(String networkError) async {
    try {
      final cache = await AssetCache.open();
      final cached = await cache.queryPage(folderPrefix: _folder, limit: _kPageSize);
      if (!mounted) return;
      final reallyOffline = await _isReallyOffline();
      if (!mounted) return;
      if (cached.assets.isEmpty) {
        // Blank slate: network is down and nothing's cached. Rather than a hard
        // error, mark offline + clear the loading flag so the body can still
        // render the "On this device" section (the phone's own camera roll)
        // while the error/empty placeholder shows for the server grid.
        setState(() {
          _error = networkError;
          _offline = reallyOffline;
          _loadingFirst = false;
        });
        if (_devicePhotos.isEmpty) unawaited(_maybeLoadDevicePhotos());
        return;
      }
      final last = cached.assets.last;
      setState(() {
        _error = null;
        _offline = reallyOffline;
        _assets
          ..clear()
          ..addAll(cached.assets);
        _thumbs
          ..clear()
          ..addAll(cached.thumbs);
        _recomputeDerived();
        _cursor = null;
        _offBeforeTs = (last.capturedAt ?? last.createdAt).millisecondsSinceEpoch;
        _offBeforeId = last.id;
        _offHasMore = cached.assets.length == _kPageSize;
        _loadingFirst = false;
      });
      // Now that we know we're offline, surface the phone's own camera roll in
      // the library even on a blank-slate launch (no cached server assets path
      // hits _fail below; this path has at least the cache but device photos
      // are additive). Re-runs the gated loader which is idempotent.
      if (_devicePhotos.isEmpty) unawaited(_maybeLoadDevicePhotos());
    } catch (_) {
      _fail(networkError);
    }
  }

  Future<void> _loadMoreOffline() async {
    if (!_offHasMore || _offBeforeTs == null || _offBeforeId == null) return;
    setState(() => _loadingMore = true);
    try {
      final cache = await AssetCache.open();
      final cached = await cache.queryPage(
        beforeSortTs: _offBeforeTs,
        beforeId: _offBeforeId,
        folderPrefix: _folder,
        limit: _kPageSize,
      );
      if (!mounted) return;
      setState(() {
        _assets.addAll(cached.assets);
        _thumbs.addAll(cached.thumbs);
        _recomputeDerived();
        if (cached.assets.isNotEmpty) {
          final last = cached.assets.last;
          _offBeforeTs = (last.capturedAt ?? last.createdAt).millisecondsSinceEpoch;
          _offBeforeId = last.id;
        }
        _offHasMore = cached.assets.length == _kPageSize;
        _loadingMore = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingMore = false);
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
        kind: _effectiveKind(),
        unclassified: _isUnsorted,
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
        _recomputeDerived();
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
      unawaited(_persist(page.assets, newThumbs));
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
                          final ok = await showDialog<bool>(
                            context: sheetCtx,
                            builder: (ctx) => AlertDialog(
                              title: const Text("Clear failed uploads?"),
                              content: const Text(
                                  "Failed uploads will be removed from the queue. This can't be undone."),
                              actions: [
                                TextButton(
                                  onPressed: () => Navigator.of(ctx).pop(false),
                                  child: const Text("Cancel"),
                                ),
                                FilledButton(
                                  onPressed: () => Navigator.of(ctx).pop(true),
                                  child: const Text("Clear"),
                                ),
                              ],
                            ),
                          );
                          if (ok != true) return;
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

  /// Load the device camera-roll recents that back the "On this device"
  /// section, then ensure they're queued for upload. Only runs when photo
  /// access is already granted (we never prompt here) — so a blank-slate /
  /// offline launch shows the phone's own photos in the library and they
  /// upload via the existing queue when connectivity returns.
  ///
  /// Auto-queue: we reuse [CameraRollScanner.scanAndEnqueue] (the same
  /// hash + sha256-deduped [UploadQueue.enqueue] path the auto-import uses)
  /// rather than writing a second uploader. The scanner is idempotent, so
  /// calling it here on top of `_maybeScanCameraRoll` never double-queues.
  Future<void> _maybeLoadDevicePhotos() async {
    if (!await DevicePhotos.hasPermission()) return;
    // Always surface the strip when access is granted — the operator wants the
    // phone's own photos visible IMMEDIATELY, online or off, regardless of the
    // auto-import setting. Reading recents + resolving KIND is purely local
    // (no network), so this paints well before any server call resolves.
    final recents = await DevicePhotos.recent(limit: 120);
    if (!mounted || recents.isEmpty) return;
    // Resolve KIND for the strip before showing it so the lens filter is
    // honored on first paint (otherwise the unfiltered list flashes through
    // the Moments tab — exactly the bug this section is here to prevent).
    final kinds = await DeviceKind.resolveAll(recents);
    if (!mounted) return;
    setState(() {
      _devicePhotos = recents;
      _deviceKindById = kinds;
    });
    // Auto-enqueue for upload ONLY when the user opted into camera-roll backup.
    // Showing the strip is display-only; we never upload without consent.
    final autoImport = await SettingsStore.getAutoImport();
    if (!autoImport) return;
    // Enqueue what the user is now looking at so it backs up when online.
    // Best-effort + fire-and-forget: the existing drain (resume / foreground
    // service / WorkManager) does the actual upload.
    final n = await CameraRollScanner.scanAndEnqueue();
    if (!mounted) return;
    if (n > 0) {
      await _refreshQueueBadge();
      UploadQueue.drain().then((ok) {
        if (!mounted) return;
        _refreshQueueBadge();
        if (ok > 0) _softRefresh();
      });
    }
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

  /// Personal-timeline view of the loaded set — SHOOT assets (ADR 0008/0009)
  /// are hidden so shoot work never pollutes the timeline, even from the
  /// non-scope-partitioned offline cache. Order is preserved.
  List<Asset> get _visibleAssets => _visible;

  /// Recompute the three derived views of _assets. MUST be called inside every
  /// setState that mutates _assets (load / prime / prepend / loadMore / trash).
  void _recomputeDerived() {
    final visible = _assets.where((a) => a.scope != "SHOOT").toList();
    _visible = visible;
    _groups = _groupAssetsByMonth(visible);
    _flatIdxById = {
      for (var i = 0; i < visible.length; i++) visible[i].id: i,
    };
  }

  Future<void> _openDetail(int i) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>?>(
      MaterialPageRoute(
        builder: (_) => AssetDetailScreen(
          client: _client,
          assets: _visibleAssets,
          initialIndex: i,
        ),
      ),
    );
    if (!mounted || result == null) return;
    // Detail popped w/ a trashed id — drop it from our local list so the
    // grid reflects the action without a full refresh.
    final trashedId = result["trashedId"] as String?;
    if (trashedId != null) {
      setState(() {
        _assets.removeWhere((a) => a.id == trashedId);
        _recomputeDerived();
      });
    }
  }

  // M8 — multi-select helpers.
  void _toggleSelect(String id) {
    setState(() {
      if (_selected.remove(id)) {
        if (_selected.isEmpty) _selecting = false;
      } else {
        _selected.add(id);
      }
    });
  }

  void _enterSelect(String id) {
    setState(() {
      _selecting = true;
      _selected.add(id);
    });
  }

  void _exitSelect() {
    setState(() {
      _selecting = false;
      _selected.clear();
    });
  }

  PreferredSizeWidget _selectionAppBar() {
    return AppBar(
      leading: IconButton(
        icon: const Icon(Icons.close),
        tooltip: "Cancel selection",
        onPressed: _exitSelect,
      ),
      title: Text("${_selected.length} selected"),
      actions: [
        IconButton(
          tooltip: "Export zip",
          icon: const Icon(Icons.archive_outlined),
          onPressed: _selected.isEmpty
              ? null
              : () => exportAndShareZip(
                    context,
                    _client,
                    ids: _selected.toList(),
                  ),
        ),
      ],
    );
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
      appBar: _selecting
          ? _selectionAppBar()
          : AppBar(
        // Inside a folder, show a back affordance to return to the root view
        // (otherwise the only way back was via the drawer). null leading keeps
        // the default drawer hamburger at the root.
        leading: _folder != null
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                tooltip: "Back to all photos",
                onPressed: () {
                  setState(() => _folder = null);
                  _refresh();
                },
              )
            : null,
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

  void _setLens(String lens) {
    if (_lens == lens) return;
    setState(() => _lens = lens);
    _refresh();
  }

  bool get _hasNonLensFilter => _folder != null;

  /// Slivers for the "On this device" section: a header + a 3-col grid of
  /// local camera-roll thumbnails. Empty when there are no device recents. The
  /// caption only appears offline, where it's the user's cue that these will
  /// back up later. Lives above the server grid.
  /// True when the on-device kind matches the active lens. "all" passes
  /// everything; "moment" also matches unresolved tiles (the resolver fills
  /// in moment for unknown / default images, so this only matters during the
  /// short window before kinds are computed).
  bool _deviceTileMatchesLens(AssetEntity e) {
    if (_splitOn) {
      // The device strip only renders on the Photos surface (see the gate in
      // the grid build). Photos lenses are all / moment / video.
      final k = _deviceKindById[e.id];
      if (_splitLens == "moment") return k == null || k == kindMoment;
      if (_splitLens == "video") return k == kindVideo;
      return k == null || k == kindMoment || k == kindVideo; // all
    }
    if (_lens == "all") return true;
    final k = _deviceKindById[e.id];
    if (k == null) return _lens == "moment";
    return k == _lens;
  }

  List<Widget> _deviceSlivers() {
    if (_devicePhotos.isEmpty) return const [];
    final shown = _devicePhotos.where(_deviceTileMatchesLens).toList();
    if (shown.isEmpty) return const [];
    return [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.smartphone_outlined,
                    size: 18,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    "On this device",
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ],
              ),
              if (_offline)
                Padding(
                  padding: const EdgeInsets.only(top: 2, left: 26),
                  child: Text(
                    "These upload to Fonto when you're back online.",
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                  ),
                ),
            ],
          ),
        ),
      ),
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
        sliver: SliverGrid(
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            crossAxisSpacing: 4,
            mainAxisSpacing: 4,
          ),
          delegate: SliverChildBuilderDelegate(
            (context, i) {
              final entity = shown[i];
              return RepaintBoundary(
                child: _DeviceTile(
                  entity: entity,
                  onTap: () => _openDeviceAsset(entity),
                ),
              );
            },
            childCount: shown.length,
          ),
        ),
      ),
    ];
  }

  void _openDeviceAsset(AssetEntity entity) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DeviceAssetViewerScreen(entity: entity),
      ),
    );
  }

  Widget _buildBody() {
    // Files surface owns its own fetch + list rendering (FilesSurface); it
    // bypasses the grid/timeline machinery entirely.
    if (_isFiles) {
      return Column(
        children: [
          _libraryHeader(),
          Expanded(
            child: FilesSurface(
              client: _client,
              kindParam: _effectiveKind(),
              directoryPathPrefix: _folder,
            ),
          ),
        ],
      );
    }
    if (_loadingFirst) {
      // Cold start with nothing cached yet: still paint the local camera-roll
      // strip immediately (no network) above a small loading indicator for the
      // server grid, so the user sees their phone's photos right away instead
      // of a blank spinner.
      return Column(
        children: [
          _libraryHeader(),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _refresh,
              child: CustomScrollView(
                controller: _scroll,
                slivers: [
                  if (_folder == null && _isPhotos) ..._deviceSlivers(),
                  const SliverToBoxAdapter(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: CircularProgressIndicator()),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    }
    if (_error != null) {
      // Even when the server grid can't load, still surface the phone's own
      // camera roll (offline blank slate) so the user sees their photos and
      // knows they'll upload once back online.
      if (_devicePhotos.isNotEmpty) {
        return Column(
          children: [
            _libraryHeader(),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _refresh,
                child: CustomScrollView(
                  controller: _scroll,
                  slivers: [
                    ..._deviceSlivers(),
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
                        child: Text(
                          "Your Fonto library will appear here once you're "
                          "back online. Pull to retry.",
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant,
                              ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      }
      return Column(
        children: [
          _libraryHeader(),
          Expanded(child: ListErrorState(onRetry: _refresh)),
        ],
      );
    }

    // ADR 0008/0009 — personal timeline hides SHOOT at the display layer.
    // Online reads already default PERSONAL server-side; this also covers the
    // offline-cache paths, which aren't scope-partitioned.
    // Derived views are cached in State and refreshed by _recomputeDerived
    // only when _assets mutates, so a plain setState (e.g. selection toggle)
    // no longer pays for three O(n) passes on every rebuild.
    final visible = _visible;
    final groups = _groups;
    final flatIdxById = _flatIdxById;

    final scroll = RefreshIndicator(
      onRefresh: _refresh,
      child: CustomScrollView(
        controller: _scroll,
        slivers: [
          if (_offline)
            SliverToBoxAdapter(
              child: Container(
                width: double.infinity,
                color: Theme.of(context).colorScheme.secondaryContainer,
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Row(
                  children: [
                    Icon(
                      Icons.cloud_off,
                      size: 16,
                      color: Theme.of(context).colorScheme.onSecondaryContainer,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        "Offline — showing your saved library. Pull to retry.",
                        style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(context)
                              .colorScheme
                              .onSecondaryContainer,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          // "On this device" — local camera-roll recents, above the server
          // grid. Only the root view (no folder filter) shows it.
          if (_folder == null && _isPhotos) ..._deviceSlivers(),
          if (_stats != null && _folder == null)
            SliverToBoxAdapter(child: _StatsBar(stats: _stats!)),
          // "On this day" recap — parity with the web dashboard MemoryCard.
          // Self-fetches; renders nothing when there's no prior-year history.
          // Root unfiltered Photos view only, same as the device-recents strip.
          if (_folder == null && _isPhotos)
            SliverToBoxAdapter(child: _MemoriesStrip(client: _client)),
          if (visible.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: ListEmptyState(
                message: _hasNonLensFilter
                    ? filteredEmptyForKind(_lens)
                    : defaultEmptyForKind(_lens),
                filtered: _hasNonLensFilter,
                onClearFilters:
                    _hasNonLensFilter ? () => _selectFolder(null) : null,
              ),
            )
          else
            for (final g in groups) ...[
              // pinned: false — Flutter stacks every `pinned: true`
              // SliverPersistentHeader at the top instead of swapping one for
              // the next, so 13 month headers ate ~468 px of viewport and the
              // photos disappeared off-screen. Section labels still ride above
              // each grid; the right-rail scrubber gives "where am I" context.
              SliverPersistentHeader(
                pinned: false,
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
                        key: ValueKey(asset.id),
                        child: _AssetTile(
                          asset: asset,
                          url: _thumbs[asset.id],
                          selected: _selected.contains(asset.id),
                          onTap: () {
                            if (_selecting) {
                              _toggleSelect(asset.id);
                              return;
                            }
                            _openDetail(flatIdxById[asset.id] ?? 0);
                          },
                          onLongPress: () => _enterSelect(asset.id),
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
    final Widget timeline = (_buckets.length <= 1 || _assets.isEmpty)
        ? scroll
        : Stack(
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

    // Phase 7 — lens selector pinned above the timeline. Matches the web
    // Library lens (Moments / Screenshots / Documents / Videos / All). The
    // active value drives ?kind= on refresh/loadMore.
    return Column(
      children: [
        _libraryHeader(),
        Expanded(child: timeline),
      ],
    );
  }

}

/// Phase 7 — lens selector. Mirrors web's `LENSES` constant in library/page.tsx.
/// "moment" is the default; "all" clears the ?kind= filter.
class _LensSelector extends StatelessWidget {
  const _LensSelector({required this.active, required this.onChange});

  final String active;
  final ValueChanged<String> onChange;

  static const _lenses = <(String, String, IconData)>[
    ("moment", "Moments", Icons.photo_outlined),
    ("screenshot", "Screenshots", Icons.smartphone_outlined),
    ("graphics", "Graphics", Icons.palette_outlined),
    ("document", "Documents", Icons.description_outlined),
    ("video", "Videos", Icons.videocam_outlined),
    ("all", "All", Icons.grid_view_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        itemCount: _lenses.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final (value, label, icon) = _lenses[i];
          final isActive = value == active;
          return InkWell(
            onTap: () => onChange(value),
            borderRadius: const BorderRadius.all(Radius.circular(20)),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: isActive
                    ? theme.colorScheme.primary
                    : theme.colorScheme.surfaceContainerHighest,
                borderRadius: const BorderRadius.all(Radius.circular(20)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    icon,
                    size: 16,
                    color: isActive
                        ? theme.colorScheme.onPrimary
                        : theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    label,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: isActive
                          ? theme.colorScheme.onPrimary
                          : theme.colorScheme.onSurface,
                      fontWeight: isActive ? FontWeight.w600 : FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Photos-Files split — surface segmented control + Inbox banner + scoped lens
/// chips. Mirrors the web LibrarySurfaceControl. Rendered only when the
/// `librarySurfaceSplit` flag is on.
class _SurfaceSelector extends StatelessWidget {
  const _SurfaceSelector({
    required this.surface,
    required this.lens,
    required this.unsortedCount,
    required this.onSurface,
    required this.onLens,
  });

  final String surface; // photos | files | unsorted
  final String lens;
  final int unsortedCount;
  final ValueChanged<String> onSurface;
  final ValueChanged<String> onLens;

  static const _photoLenses = <(String, String, IconData)>[
    ("all", "All", Icons.grid_view_outlined),
    ("moment", "Moments", Icons.photo_outlined),
    ("video", "Videos", Icons.videocam_outlined),
  ];
  static const _fileLenses = <(String, String, IconData)>[
    ("all", "All", Icons.grid_view_outlined),
    ("screenshot", "Screenshots", Icons.smartphone_outlined),
    ("graphics", "Graphics", Icons.palette_outlined),
    ("document", "Documents", Icons.description_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final inUnsorted = surface == "unsorted";
    final lenses = surface == "files" ? _fileLenses : _photoLenses;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Inbox banner — only when there is something to triage, or while the
        // user is inside the Inbox surface (so they can leave it).
        if (unsortedCount > 0 || inUnsorted)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Material(
              color: inUnsorted
                  ? theme.colorScheme.secondaryContainer
                  : theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => onSurface(inUnsorted ? "photos" : "unsorted"),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(
                    children: [
                      Icon(Icons.help_outline,
                          size: 18,
                          color: inUnsorted
                              ? theme.colorScheme.onSecondaryContainer
                              : theme.colorScheme.onSurfaceVariant),
                      const SizedBox(width: 8),
                      Text("Unsorted",
                          style: theme.textTheme.labelLarge?.copyWith(
                            color: inUnsorted
                                ? theme.colorScheme.onSecondaryContainer
                                : theme.colorScheme.onSurface,
                          )),
                      const Spacer(),
                      if (inUnsorted)
                        Text("Done",
                            style: theme.textTheme.labelMedium?.copyWith(
                                color:
                                    theme.colorScheme.onSecondaryContainer))
                      else
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: theme.colorScheme.primary,
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text("$unsortedCount pending",
                              style: theme.textTheme.labelSmall?.copyWith(
                                  color: theme.colorScheme.onPrimary)),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),

        // Segmented control — Photos / Files.
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
          child: Container(
            decoration: BoxDecoration(
              border: Border.all(color: theme.colorScheme.outlineVariant),
              borderRadius: BorderRadius.circular(24),
            ),
            padding: const EdgeInsets.all(3),
            child: Row(
              children: [
                _seg(theme, "photos", "Photos", Icons.photo_library_outlined),
                _seg(theme, "files", "Files", Icons.folder_outlined),
              ],
            ),
          ),
        ),

        // Surface-scoped lens chips (hidden inside Inbox).
        if (!inUnsorted)
          SizedBox(
            height: 44,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              itemCount: lenses.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final (value, label, icon) = lenses[i];
                final isActive = value == lens;
                return InkWell(
                  onTap: () => onLens(value),
                  borderRadius: const BorderRadius.all(Radius.circular(20)),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    decoration: BoxDecoration(
                      color: isActive
                          ? theme.colorScheme.primary
                          : theme.colorScheme.surfaceContainerHighest,
                      borderRadius: const BorderRadius.all(Radius.circular(20)),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(icon,
                            size: 16,
                            color: isActive
                                ? theme.colorScheme.onPrimary
                                : theme.colorScheme.onSurfaceVariant),
                        const SizedBox(width: 6),
                        Text(label,
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: isActive
                                  ? theme.colorScheme.onPrimary
                                  : theme.colorScheme.onSurface,
                              fontWeight:
                                  isActive ? FontWeight.w600 : FontWeight.w500,
                            )),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
      ],
    );
  }

  Widget _seg(ThemeData theme, String value, String label, IconData icon) {
    final isActive = surface == value;
    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () => onSurface(value),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: isActive
                ? theme.colorScheme.secondaryContainer
                : Colors.transparent,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon,
                  size: 18,
                  color: isActive
                      ? theme.colorScheme.onSecondaryContainer
                      : theme.colorScheme.onSurfaceVariant),
              const SizedBox(width: 6),
              Text(label,
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: isActive
                        ? theme.colorScheme.onSecondaryContainer
                        : theme.colorScheme.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                  )),
            ],
          ),
        ),
      ),
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
                      boxShadow: [
                        BoxShadow(
                          color: scheme.shadow.withValues(alpha: 0.25),
                          blurRadius: 4,
                        ),
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
                      style: Theme.of(context).textTheme.labelLarge?.copyWith(
                            color: scheme.onInverseSurface,
                            fontWeight: FontWeight.w600,
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
    void openTransfers() => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const TransfersScreen()),
        );
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
                            ? "Importing all Drive files to your library…"
                              "${total > 0 ? ' ($total queued)' : ''}"
                            : "Downloading $dlPending Drive "
                              "${dlPending == 1 ? 'file' : 'files'} from the cloud…";
                        return InkWell(
                          onTap: openTransfers,
                          child: Container(
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
                                Expanded(
                                  child: Text(
                                    label,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall
                                        ?.copyWith(
                                          color: scheme.onTertiaryContainer,
                                        ),
                                  ),
                                ),
                                Icon(Icons.chevron_right,
                                    size: 16,
                                    color: scheme.onTertiaryContainer),
                              ],
                            ),
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
                InkWell(
                  onTap: openTransfers,
                  child: Container(
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
                            Expanded(
                              child: Text(
                                "Uploading ${up.done.clamp(0, up.total)} of ${up.total} to your library",
                                style: Theme.of(context)
                                    .textTheme
                                    .bodySmall
                                    ?.copyWith(
                                      color: scheme.onPrimaryContainer,
                                    ),
                              ),
                            ),
                            Icon(Icons.chevron_right,
                                size: 16, color: scheme.onPrimaryContainer),
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
                ),
              );
            }

            if (processing > 0) {
              rows.add(
                InkWell(
                  onTap: openTransfers,
                  child: Container(
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
                        Expanded(
                          child: Text(
                            "Processing $processing "
                            "${processing == 1 ? 'item' : 'items'} on Fonto…",
                            style: Theme.of(context)
                                .textTheme
                                .bodySmall
                                ?.copyWith(
                                  color: scheme.onSecondaryContainer,
                                ),
                          ),
                        ),
                        Icon(Icons.chevron_right,
                            size: 16, color: scheme.onSecondaryContainer),
                      ],
                    ),
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
    this.onLongPress,
    this.selected = false,
  });
  final Asset asset;
  final String? url;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool selected;

  bool get _isImage => asset.mimeType.startsWith("image/");
  bool get _isVideo => asset.mimeType.startsWith("video/");

  @override
  Widget build(BuildContext context) {
    final placeholderColor =
        Theme.of(context).colorScheme.surfaceContainerHighest;
    final Widget media;
    if (url == null) {
      // No URL yet: images/videos get a neutral box; docs get the doc card.
      media = (_isImage || _isVideo)
          ? Container(color: placeholderColor)
          : _DocPlaceholder(asset: asset);
    } else if (_isImage || _isVideo) {
      media = Hero(
        tag: asset.id,
        child: CachedNetworkImage(
          imageUrl: url!,
          // Key the disk cache by asset id (not the rotating signed URL) so
          // cached bytes still resolve offline after the URL expires.
          cacheManager: OfflineCache.thumbs,
          cacheKey: asset.id,
          fit: BoxFit.cover,
          // Decode at grid-tile resolution to cap per-tile memory ~130×130px.
          memCacheWidth: 260,
          memCacheHeight: 260,
          placeholder: (_, __) => Container(color: placeholderColor),
          errorWidget: (_, __, ___) => ColoredBox(
            color: placeholderColor,
            child: const Icon(Icons.broken_image),
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
          cacheManager: OfflineCache.thumbs,
          cacheKey: asset.id,
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
      onLongPress: onLongPress,
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
          // M12 / ADR 0014 — motion (Live) photo badge (parity with web grid).
          if (_isImage && asset.motionPhoto)
            const Positioned(
              left: 4,
              top: 4,
              child: LiveBadge(compact: true),
            ),
          if (asset.isProcessing)
            const Positioned(
              right: 4,
              bottom: 4,
              child: _ProcessingBadge(),
            ),
          if (selected)
            Container(
              color: Colors.black.withValues(alpha: 0.4),
              alignment: Alignment.topRight,
              padding: const EdgeInsets.all(4),
              child: const Icon(Icons.check_circle, color: Colors.white),
            ),
        ],
      ),
    );
  }
}

/// A single local camera-roll photo in the "On this device" grid. Renders the
/// thumbnail straight from the device via [AssetEntity.thumbnailDataWithSize]
/// — fully offline, no network. A cloud-arrow-up badge signals it's pending
/// upload to Fonto.
class _DeviceTile extends StatelessWidget {
  const _DeviceTile({required this.entity, required this.onTap});
  final AssetEntity entity;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final placeholderColor =
        Theme.of(context).colorScheme.surfaceContainerHighest;
    return GestureDetector(
      onTap: onTap,
      child: Stack(
        fit: StackFit.expand,
        children: [
          FutureBuilder<Uint8List?>(
            future:
                entity.thumbnailDataWithSize(const ThumbnailSize.square(260)),
            builder: (context, snapshot) {
              if (snapshot.connectionState != ConnectionState.done) {
                return Container(color: placeholderColor);
              }
              final data = snapshot.data;
              if (data == null) {
                return ColoredBox(
                  color: placeholderColor,
                  child: const Icon(Icons.broken_image),
                );
              }
              return Image.memory(data, fit: BoxFit.cover);
            },
          ),
          Positioned(
            right: 4,
            bottom: 4,
            child: Container(
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color:
                    Theme.of(context).colorScheme.scrim.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Icon(
                Icons.cloud_upload_outlined,
                size: 14,
                color: Colors.white,
              ),
            ),
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
        // Scrim-over-photo overlay — must stay dark regardless of theme so the
        // spinner reads on a bright photo behind it.
        color: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.6),
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
    final theme = Theme.of(context);
    final dot = asset.filename.lastIndexOf(".");
    final ext = dot > 0 && dot < asset.filename.length - 1
        ? asset.filename.substring(dot + 1).toUpperCase()
        : "DOC";
    return Container(
      color: theme.colorScheme.surfaceContainerHigh,
      padding: const EdgeInsets.all(6),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.description_outlined,
              size: 34, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(height: 4),
          Text(
            ext,
            style: theme.textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.bold,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            asset.filename,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
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
        // Scrim-over-photo overlay; white-on-black reads on any image
        // beneath the badge.
        color: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.6),
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
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text(
                  "FOLDERS",
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
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

/// "On this day" home recap — horizontal strip of one thumbnail per prior year
/// matching today. Mirrors the web dashboard MemoryCard: self-fetches, renders
/// nothing when there's no history, and opens the full Memories view on tap.
class _MemoriesStrip extends StatefulWidget {
  const _MemoriesStrip({required this.client});

  final FontoClient client;

  @override
  State<_MemoriesStrip> createState() => _MemoriesStripState();
}

class _MemoriesStripState extends State<_MemoriesStrip> {
  List<MemoryYear> _years = const [];
  Map<String, String> _thumbs = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final years = await widget.client.memories();
      // One cover thumb per year (first asset).
      final coverIds = <String>[
        for (final y in years)
          if (y.assets.isNotEmpty) y.assets.first.id,
      ];
      Map<String, String> thumbs = const {};
      if (coverIds.isNotEmpty) {
        thumbs = await widget.client.assetUrls(coverIds, variant: "thumb");
      }
      if (!mounted) return;
      setState(() {
        _years = years;
        _thumbs = thumbs;
      });
    } catch (_) {
      // Silent — the strip just stays hidden on failure.
    }
  }

  void _openMemories() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => MemoriesScreen(client: widget.client),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_years.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome, size: 18, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Text("On this day", style: theme.textTheme.titleSmall),
              const Spacer(),
              TextButton(
                onPressed: _openMemories,
                child: const Text("View all"),
              ),
            ],
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 116,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _years.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (_, i) {
                final y = _years[i];
                final cover = y.assets.isEmpty ? null : _thumbs[y.assets.first.id];
                final diff = DateTime.now().year - y.year;
                final label = diff == 1 ? "1y ago" : "${diff}y ago";
                return GestureDetector(
                  onTap: _openMemories,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: SizedBox(
                      width: 112,
                      height: 116,
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          if (cover != null)
                            CachedNetworkImage(
                              imageUrl: cover,
                              fit: BoxFit.cover,
                              memCacheWidth: 240,
                              placeholder: (ctx, _) => imageSkeleton(ctx),
                              errorWidget: (ctx, _, __) => ColoredBox(
                                color: theme.colorScheme.surfaceContainerHighest,
                              ),
                            )
                          else
                            ColoredBox(
                              color: theme.colorScheme.surfaceContainerHighest,
                              child: const Icon(Icons.image_outlined),
                            ),
                          Positioned(
                            left: 0,
                            right: 0,
                            bottom: 0,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 6),
                              decoration: const BoxDecoration(
                                gradient: LinearGradient(
                                  begin: Alignment.bottomCenter,
                                  end: Alignment.topCenter,
                                  colors: [Colors.black87, Colors.transparent],
                                ),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    label,
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  Text(
                                    "${y.count} ${y.count == 1 ? 'photo' : 'photos'}",
                                    style: const TextStyle(
                                      color: Colors.white70,
                                      fontSize: 10,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
