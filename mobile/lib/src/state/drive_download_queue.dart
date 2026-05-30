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

class DriveDownloadQueue {
  DriveDownloadQueue._(this._db);

  static const _maxAttempts = 3;
  static const _batchSize = 30;
  final Database _db;
  static DriveDownloadQueue? _instance;

  /// Live count of Drive files still waiting to be downloaded.
  /// HomeScreen listens to show/hide the download progress banner.
  static final ValueNotifier<int> pending = ValueNotifier(0);

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
    int done = 0;

    for (final row in rows) {
      final id = row["id"] as String;
      final name = row["name"] as String;
      final virtualPath = row["virtual_path"] as String;
      try {
        final uri = Uri.parse("$_kDriveApiBase/files/$id")
            .replace(queryParameters: {"alt": "media"});
        final req = http.Request("GET", uri)..headers.addAll(headers);
        final streamed = await http.Client().send(req);
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

    unawaited(UploadQueue.drain());
    return done;
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
