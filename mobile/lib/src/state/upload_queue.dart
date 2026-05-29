// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Persistent local upload queue. Survives app restarts + backgrounding.
//
// Schema:
//   uploads (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     file_path TEXT NOT NULL,
//     virtual_path TEXT NOT NULL,
//     sha256 TEXT NOT NULL UNIQUE,        -- dedupe key
//     state TEXT NOT NULL,                -- 'pending' | 'in_flight' | 'failed'
//     attempts INTEGER NOT NULL DEFAULT 0,
//     last_error TEXT,
//     created_at INTEGER NOT NULL,        -- epoch ms
//     uploaded_asset_id TEXT
//   )
//
// `INSERT OR IGNORE` on sha256 makes enqueue idempotent — picking the
// same photo twice from the gallery doesn't double-queue. Drain pulls
// `state='pending' AND attempts < 5` ordered by `created_at ASC`, sets
// state='in_flight' before the network call, marks 'completed' (drops
// from the table) on success or 'failed' on terminal error. Retryable
// failures bump attempts + reset state to 'pending' for the next drain.

import "dart:io";

import "package:flutter/foundation.dart";
import "package:convert/convert.dart";
import "package:crypto/crypto.dart";
import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:sqflite/sqflite.dart";

import "../api/fonto_client.dart";
import "auth_store.dart";

class UploadQueueEntry {
  UploadQueueEntry({
    required this.id,
    required this.filePath,
    required this.virtualPath,
    required this.sha256,
    required this.state,
    required this.attempts,
    required this.createdAtMs,
    this.lastError,
    this.uploadedAssetId,
  });

  final int id;
  final String filePath;
  final String virtualPath;
  final String sha256;
  final String state;
  final int attempts;
  final String? lastError;
  final int createdAtMs;
  final String? uploadedAssetId;

  static UploadQueueEntry fromRow(Map<String, Object?> r) => UploadQueueEntry(
        id: r["id"] as int,
        filePath: r["file_path"] as String,
        virtualPath: r["virtual_path"] as String,
        sha256: r["sha256"] as String,
        state: r["state"] as String,
        attempts: r["attempts"] as int,
        lastError: r["last_error"] as String?,
        createdAtMs: r["created_at"] as int,
        uploadedAssetId: r["uploaded_asset_id"] as String?,
      );
}

/// Live snapshot of an in-progress drain, broadcast via
/// [UploadQueue.progress] so the UI can show "Uploading X of Y".
class UploadProgress {
  const UploadProgress({required this.done, required this.total});
  final int done;
  final int total;
  int get remaining => (total - done).clamp(0, total);
}

class UploadQueue {
  UploadQueue._(this._db);

  static const _maxAttempts = 5;
  final Database _db;
  static UploadQueue? _instance;

  /// Null when no drain is running; otherwise the latest progress snapshot.
  /// HomeScreen listens to render a live upload bar.
  static final ValueNotifier<UploadProgress?> progress =
      ValueNotifier<UploadProgress?>(null);

  static Future<UploadQueue> open() async {
    if (_instance != null) return _instance!;
    final docs = await getApplicationDocumentsDirectory();
    final dbPath = p.join(docs.path, "fonto-uploads.db");
    final db = await openDatabase(
      dbPath,
      version: 1,
      onCreate: (db, _) async {
        await db.execute("""
          CREATE TABLE uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            virtual_path TEXT NOT NULL,
            sha256 TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            uploaded_asset_id TEXT
          )
        """);
        await db.execute(
          "CREATE INDEX uploads_state_idx ON uploads(state, created_at)",
        );
      },
    );
    _instance = UploadQueue._(db);
    return _instance!;
  }

  /// Hash the bytes (streamed; doesn't load the whole file). Returns
  /// hex digest. Used for the UNIQUE dedupe key + idempotent enqueue.
  static Future<String> hashFile(File file) async {
    final sink = AccumulatorSink<Digest>();
    final converter = sha256.startChunkedConversion(sink);
    await for (final Uint8List chunk in file.openRead().map(
      (l) => Uint8List.fromList(l),
    )) {
      converter.add(chunk);
    }
    converter.close();
    final digest = sink.events.single;
    return digest.toString();
  }

  /// Returns the inserted row id, or null if a row w/ the same sha256
  /// already exists (idempotent — caller can treat as a no-op).
  Future<int?> enqueue({
    required String filePath,
    required String virtualPath,
    required String sha256Hex,
  }) async {
    final id = await _db.insert(
      "uploads",
      {
        "file_path": filePath,
        "virtual_path": virtualPath,
        "sha256": sha256Hex,
        "state": "pending",
        "attempts": 0,
        "created_at": DateTime.now().millisecondsSinceEpoch,
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
    return id == 0 ? null : id;
  }

  Future<int> pendingCount() async {
    final r = await _db.rawQuery(
      "SELECT COUNT(*) AS c FROM uploads WHERE state IN ('pending','in_flight')",
    );
    return (r.first["c"] as int?) ?? 0;
  }

  Future<int> failedCount() async {
    final r = await _db.rawQuery(
      "SELECT COUNT(*) AS c FROM uploads WHERE state = 'failed'",
    );
    return (r.first["c"] as int?) ?? 0;
  }

  /// Crash recovery: a drain marks a row `in_flight` before the network
  /// call, but a killed background isolate (Android caps each run at a few
  /// minutes — a big camera-roll import never finishes in one) leaves the
  /// row stranded `in_flight` forever, since [nextBatch] only picks
  /// `pending`. Reset them so the next drain retries instead of the count
  /// flooring out. Returns how many were requeued.
  Future<int> requeueStranded() async {
    return _db.update(
      "uploads",
      {"state": "pending"},
      where: "state = 'in_flight'",
    );
  }

  /// Failed rows (retries exhausted or terminal error), newest first — for
  /// the "what's stuck and why" sheet.
  Future<List<UploadQueueEntry>> recentFailures({int limit = 50}) async {
    final rows = await _db.query(
      "uploads",
      where: "state = 'failed'",
      orderBy: "created_at DESC",
      limit: limit,
    );
    return rows.map(UploadQueueEntry.fromRow).toList();
  }

  /// Reset every failed row back to a fresh pending attempt. Returns count.
  Future<int> retryFailed() async {
    return _db.rawUpdate(
      "UPDATE uploads SET state = 'pending', attempts = 0, last_error = NULL WHERE state = 'failed'",
    );
  }

  /// Drop failed rows from the queue entirely. Returns count.
  Future<int> clearFailed() async {
    return _db.delete("uploads", where: "state = 'failed'");
  }

  Future<List<UploadQueueEntry>> nextBatch({int limit = 10}) async {
    final rows = await _db.query(
      "uploads",
      where: "state = ? AND attempts < ?",
      whereArgs: ["pending", _maxAttempts],
      orderBy: "created_at ASC",
      limit: limit,
    );
    return rows.map(UploadQueueEntry.fromRow).toList();
  }

  Future<void> _markInFlight(int id) async {
    await _db.update(
      "uploads",
      {"state": "in_flight"},
      where: "id = ?",
      whereArgs: [id],
    );
  }

  Future<void> _markSuccess(int id, String assetId) async {
    // Drop the row entirely on success — keeps the table small. The
    // assetId lives in the server now; no need to track it locally.
    await _db.delete("uploads", where: "id = ?", whereArgs: [id]);
  }

  Future<void> _markFailure(int id, String err, {required bool terminal}) async {
    // Terminal errors fail immediately. Retryable ones go back to pending —
    // unless this attempt exhausts the retry budget, in which case they also
    // become 'failed' so they leave the pending count (and surface in the
    // failures sheet) instead of masquerading as pending forever.
    await _db.rawUpdate(
      """
      UPDATE uploads
      SET attempts = attempts + 1,
          last_error = ?,
          state = CASE WHEN ? OR attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE id = ?
      """,
      [err, terminal ? 1 : 0, _maxAttempts, id],
    );
  }

  /// Drain the queue using a freshly-loaded auth store + client. Safe
  /// to call from a Workmanager callback isolate. Returns the count of
  /// uploads that succeeded this run.
  static bool _draining = false;

  static Future<int> drain() async {
    // Re-entrancy guard: a foreground drain + a Workmanager-triggered drain
    // shouldn't both run and double-count progress in the same isolate.
    if (_draining) return 0;
    final auth = await AuthStore.load();
    if (!auth.isConfigured) return 0;
    final queue = await UploadQueue.open();
    final client = FontoClient(auth);
    _draining = true;
    // Recover rows stranded `in_flight` by a previously-killed drain before
    // counting, so they're retried this run instead of being skipped forever.
    await queue.requeueStranded();
    final total = await queue.pendingCount();
    var processed = 0;
    var ok = 0;
    if (total > 0) {
      progress.value = UploadProgress(done: 0, total: total);
    }
    try {
      for (;;) {
        final batch = await queue.nextBatch(limit: 10);
        if (batch.isEmpty) break;
        for (final entry in batch) {
          await queue._markInFlight(entry.id);
          try {
            final asset = await client.uploadFile(
              File(entry.filePath),
              virtualPath: entry.virtualPath,
            );
            await queue._markSuccess(entry.id, asset.id);
            ok++;
          } on ApiException catch (e) {
            // 4xx (except 429) is terminal — body's malformed, retry won't help.
            final terminal = e.status >= 400 &&
                e.status < 500 &&
                e.status != 429 &&
                e.status != 408;
            await queue._markFailure(entry.id, "${e.status}: ${e.message}",
                terminal: terminal);
          } catch (e) {
            await queue._markFailure(entry.id, e.toString(), terminal: false);
          }
          processed++;
          progress.value = UploadProgress(
            done: processed,
            total: processed > total ? processed : total,
          );
        }
      }
    } finally {
      client.close();
      _draining = false;
      progress.value = null;
    }
    return ok;
  }
}
