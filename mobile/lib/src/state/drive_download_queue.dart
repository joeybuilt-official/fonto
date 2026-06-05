// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// SQLite-backed queue for Google Drive downloads.
// Items survive app process death; WorkManager resumes them on the next run.
//
// Schema:
//   drive_downloads (
//     id TEXT PRIMARY KEY,          -- Drive file ID (dedup key)
//     name TEXT NOT NULL,
//     mime_type TEXT NOT NULL,
//     virtual_path TEXT NOT NULL,
//     state TEXT NOT NULL,           -- 'pending' | 'downloading' | 'failed'
//     attempts INTEGER NOT NULL DEFAULT 0,
//     error TEXT,
//     created_at INTEGER NOT NULL
//   )
//
// Claim pattern: claimBatch() atomically flips 'pending' → 'downloading' so
// concurrent foreground + WorkManager runners don't double-process the same item.
// recoverStuck() resets any 'downloading' rows left orphaned by a killed process.

import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:http/http.dart" as http;
import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:sqflite/sqflite.dart";
import "package:workmanager/workmanager.dart";

import "upload_queue.dart";

const _kDriveApiBase = "https://www.googleapis.com/drive/v3";
const _kDriveScope = "https://www.googleapis.com/auth/drive.readonly";

/// WorkManager task name for background Drive downloads.
const kDriveDownloadTask = "fonto.driveDownload";

/// A single row of the Drive download queue — for the Transfers detail view.
class DriveDownloadEntry {
  DriveDownloadEntry({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.virtualPath,
    required this.state,
    required this.attempts,
    required this.createdAtMs,
    this.error,
  });

  final String id;
  final String name;
  final String mimeType;
  final String virtualPath;
  final String state;
  final int attempts;
  final int createdAtMs;
  final String? error;

  static DriveDownloadEntry fromRow(Map<String, Object?> r) => DriveDownloadEntry(
        id: r["id"] as String,
        name: r["name"] as String,
        mimeType: r["mime_type"] as String,
        virtualPath: r["virtual_path"] as String,
        state: r["state"] as String,
        attempts: r["attempts"] as int,
        createdAtMs: r["created_at"] as int,
        error: r["error"] as String?,
      );
}

class DriveDownloadQueue {
  DriveDownloadQueue._(this._db);

  static const _maxAttempts = 3;
  static const _batchSize = 30;
  final Database _db;
  static DriveDownloadQueue? _instance;

  /// Live count of Drive files still waiting to be downloaded.
  /// HomeScreen listens to show/hide the download progress banner.
  static final ValueNotifier<int> pending = ValueNotifier(0);

  /// True while _downloadAllPagesFromDrive is paginating (import-all flow).
  /// Lets the banner say "Importing all…" instead of showing a batch count.
  static final ValueNotifier<bool> importingAll = ValueNotifier(false);

  /// Running total of files enqueued in the current import session (never
  /// decrements). Reset to 0 at the start of each new import so the banner
  /// shows an accurate per-run count rather than a cumulative lifetime total.
  static final ValueNotifier<int> totalEnqueued = ValueNotifier(0);

  static Future<DriveDownloadQueue> open() async {
    if (_instance != null) return _instance!;
    final docs = await getApplicationDocumentsDirectory();
    final dbPath = p.join(docs.path, "fonto-drive-queue.db");
    final db = await openDatabase(
      dbPath,
      version: 1,
      onCreate: (db, _) async {
        await db.execute("""
          CREATE TABLE drive_downloads (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            virtual_path TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at INTEGER NOT NULL
          )
        """);
        await db.execute(
          "CREATE INDEX drive_dl_state ON drive_downloads(state, created_at)",
        );
      },
    );
    _instance = DriveDownloadQueue._(db);
    await _instance!._refreshPending();
    return _instance!;
  }

  Future<void> enqueue(
    List<({String id, String name, String mimeType})> items,
    String virtualPath,
  ) async {
    if (items.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final batch = _db.batch();
    for (final item in items) {
      batch.insert(
        "drive_downloads",
        {
          "id": item.id,
          "name": item.name,
          "mime_type": item.mimeType,
          "virtual_path": virtualPath,
          "state": "pending",
          "attempts": 0,
          "created_at": now,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
    }
    await batch.commit(noResult: true);
    totalEnqueued.value += items.length;
    await _refreshPending();
  }

  /// Atomically claim up to [_batchSize] pending rows → 'downloading'.
  /// Concurrent runners (foreground + WorkManager) safely share the queue.
  Future<List<Map<String, Object?>>> claimBatch() {
    return _db.transaction((txn) async {
      final rows = await txn.query(
        "drive_downloads",
        where: "state = 'pending' AND attempts < ?",
        whereArgs: [_maxAttempts],
        orderBy: "created_at ASC",
        limit: _batchSize,
      );
      if (rows.isEmpty) return const [];
      final ids = rows.map((r) => r["id"] as String).toList();
      final ph = List.filled(ids.length, "?").join(",");
      await txn.rawUpdate(
        "UPDATE drive_downloads SET state = 'downloading' WHERE id IN ($ph)",
        ids,
      );
      return List<Map<String, Object?>>.from(rows);
    });
  }

  Future<void> markDone(String id) async {
    await _db.delete("drive_downloads", where: "id = ?", whereArgs: [id]);
    await _refreshPending();
  }

  Future<void> markFailed(String id, String err) async {
    await _db.rawUpdate(
      """
      UPDATE drive_downloads
      SET attempts = attempts + 1,
          error = ?,
          state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE id = ?
      """,
      [err, _maxAttempts, id],
    );
    await _refreshPending();
  }

  /// Reset rows orphaned by a killed process back to 'pending'.
  Future<void> recoverStuck() async {
    await _db.rawUpdate(
      "UPDATE drive_downloads SET state = 'pending' WHERE state = 'downloading'",
    );
  }

  Future<int> pendingCount() async {
    final r = await _db.rawQuery(
      "SELECT COUNT(*) AS c FROM drive_downloads "
      "WHERE state IN ('pending','downloading') AND attempts < ?",
      [_maxAttempts],
    );
    return (r.first["c"] as int?) ?? 0;
  }

  Future<void> _refreshPending() async {
    pending.value = await pendingCount();
  }

  /// Items still waiting / actively downloading, oldest first. For the
  /// Transfers queue detail view.
  Future<List<DriveDownloadEntry>> pendingItems({int limit = 200}) async {
    final rows = await _db.query(
      "drive_downloads",
      where: "state IN ('pending','downloading') AND attempts < ?",
      whereArgs: [_maxAttempts],
      orderBy: "created_at ASC",
      limit: limit,
    );
    return rows.map(DriveDownloadEntry.fromRow).toList();
  }

  /// Rows that exhausted their retries, newest first — "what's stuck and why".
  Future<List<DriveDownloadEntry>> failures({int limit = 50}) async {
    final rows = await _db.query(
      "drive_downloads",
      where: "state = 'failed' OR (state = 'pending' AND attempts >= ?)",
      whereArgs: [_maxAttempts],
      orderBy: "created_at DESC",
      limit: limit,
    );
    return rows.map(DriveDownloadEntry.fromRow).toList();
  }

  Future<int> failedCount() async {
    final r = await _db.rawQuery(
      "SELECT COUNT(*) AS c FROM drive_downloads "
      "WHERE state = 'failed' OR (state = 'pending' AND attempts >= ?)",
      [_maxAttempts],
    );
    return (r.first["c"] as int?) ?? 0;
  }

  /// Reset failed/exhausted rows back to a fresh pending attempt. Returns count.
  Future<int> retryFailed() async {
    final n = await _db.rawUpdate(
      "UPDATE drive_downloads SET state = 'pending', attempts = 0, error = NULL "
      "WHERE state = 'failed' OR (state = 'pending' AND attempts >= ?)",
      [_maxAttempts],
    );
    await _refreshPending();
    return n;
  }

  /// Drop failed/exhausted rows from the queue entirely. Returns count.
  Future<int> clearFailed() async {
    final n = await _db.rawDelete(
      "DELETE FROM drive_downloads "
      "WHERE state = 'failed' OR (state = 'pending' AND attempts >= ?)",
      [_maxAttempts],
    );
    await _refreshPending();
    return n;
  }

  /// Download one batch of pending items using [headers] for Drive auth.
  /// Each file is streamed to [tmpDir] and enqueued to UploadQueue on success.
  /// Returns the count of files successfully downloaded this call.
  static Future<int> processAll(
    Map<String, String> headers,
    Directory tmpDir,
  ) async {
    final q = await open();
    await q.recoverStuck();
    final rows = await q.claimBatch();
    if (rows.isEmpty) return 0;

    final uploadQ = await UploadQueue.open();
    final client = http.Client();
    int done = 0;

    try {
      for (final row in rows) {
        final id = row["id"] as String;
        final name = row["name"] as String;
        final virtualPath = row["virtual_path"] as String;
        try {
          final uri = Uri.parse("$_kDriveApiBase/files/$id")
              .replace(queryParameters: {"alt": "media"});
          final req = http.Request("GET", uri)..headers.addAll(headers);
          final streamed = await client
              .send(req)
              .timeout(const Duration(seconds: 30));
          if (streamed.statusCode != 200) {
            await q.markFailed(id, "HTTP ${streamed.statusCode}");
            continue;
          }
          final fname = name.isNotEmpty ? name : "$id.bin";
          final tmp = File("${tmpDir.path}/drive_${id}_$fname");
          final sink = tmp.openWrite();
          await streamed.stream.pipe(sink);
          final sha = await UploadQueue.hashFile(tmp);
          await uploadQ.enqueue(
            filePath: tmp.path,
            virtualPath: virtualPath,
            sha256Hex: sha,
          );
          await q.markDone(id);
          done++;
        } catch (e) {
          await q.markFailed(id, e.toString());
        }
      }
    } finally {
      client.close();
    }

    unawaited(UploadQueue.drain());
    return done;
  }

  /// Re-entrancy guard for [processForeground] so overlapping kicks (cold
  /// launch + lifecycle-resume + pending-change all fire near each other)
  /// don't run concurrent drains of the same queue.
  static bool _foregroundDraining = false;

  /// Foreground drain of the durable backlog. Silently re-auths with Drive,
  /// then downloads every pending item in a loop (refreshing the token per
  /// batch to survive the ~1h OAuth expiry). This is the reliable path: the
  /// background WorkManager task is heavily throttled by Android, and the
  /// import screen only drains while it's open — so a backlog left by a closed
  /// screen or a killed process would otherwise sit forever. The home screen
  /// kicks this on launch + resume. No-op when nothing is pending or Drive
  /// isn't (silently) signed in.
  static Future<void> processForeground() async {
    if (_foregroundDraining) return;
    _foregroundDraining = true;
    try {
      final q = await open();
      if (await q.pendingCount() == 0) return;
      final gsi = GoogleSignIn(scopes: [_kDriveScope]);
      final user = await gsi.signInSilently();
      if (user == null) return;
      final tmpDir = await getTemporaryDirectory();
      var consecutiveZeros = 0;
      while (await q.pendingCount() > 0 && consecutiveZeros < 3) {
        final auth = await user.authentication;
        final token = auth.accessToken;
        if (token == null) break;
        final headers = {"Authorization": "Bearer $token"};
        final downloaded = await processAll(headers, tmpDir);
        if (downloaded == 0) {
          consecutiveZeros++;
          await Future.delayed(const Duration(seconds: 3));
        } else {
          consecutiveZeros = 0;
        }
      }
      // Anything still pending (e.g. silent auth unavailable now) falls back to
      // the background task, which Android will run when it sees fit.
      if (await q.pendingCount() > 0) {
        await Workmanager().registerOneOffTask(
          kDriveDownloadTask,
          kDriveDownloadTask,
          existingWorkPolicy: ExistingWorkPolicy.keep,
          constraints: Constraints(networkType: NetworkType.connected),
        );
      }
    } finally {
      _foregroundDraining = false;
    }
  }

  /// Called from the WorkManager callback isolate.
  /// Signs in silently → downloads one batch → reschedules if more remain.
  /// Each run stays well under the 10-minute WorkManager execution window.
  static Future<void> processFromBackground() async {
    final gsi = GoogleSignIn(scopes: [_kDriveScope]);
    final user = await gsi.signInSilently();
    if (user == null) return;
    final auth = await user.authentication;
    final token = auth.accessToken;
    if (token == null) return;

    final headers = {"Authorization": "Bearer $token"};
    final tmpDir = await getTemporaryDirectory();
    await processAll(headers, tmpDir);

    // If more items remain, schedule another run. WorkManager dedupes via keep.
    final q = await open();
    if (await q.pendingCount() > 0) {
      await Workmanager().registerOneOffTask(
        kDriveDownloadTask,
        kDriveDownloadTask,
        existingWorkPolicy: ExistingWorkPolicy.keep,
        constraints: Constraints(networkType: NetworkType.connected),
      );
    }
  }
}
