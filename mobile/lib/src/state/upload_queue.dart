// SPDX-License-Identifier: MIT
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

  /// Ref-counted "a bulk import is still feeding files in" flag. While > 0 a
  /// running drain won't exit when the queue momentarily empties (downloads
  /// are slower than uploads) — that empty/refill cycle is what made the
  /// upload indicator flicker "0 of 1" on/off during a Drive import-all.
  static int _feeders = 0;
  static bool get feeding => _feeders > 0;
  static void beginFeeding() => _feeders++;
  static void endFeeding() {
    if (_feeders > 0) _feeders--;
  }

  static Future<UploadQueue> open() async {
    if (_instance != null) return _instance!;
    final docs = await getApplicationDocumentsDirectory();
    final dbPath = p.join(docs.path, "fonto-uploads.db");
    final db = await openDatabase(
      dbPath,
      version: 2,
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
            uploaded_asset_id TEXT,
            in_flight_since INTEGER
          )
        """);
        await db.execute(
          "CREATE INDEX uploads_state_idx ON uploads(state, created_at)",
        );
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
            "ALTER TABLE uploads ADD COLUMN in_flight_since INTEGER",
          );
        }
      },
    );
    _instance = UploadQueue._(db);
    return _instance!;
  }

  /// Terminal `last_error` for a queued upload whose source file has vanished
  /// from disk. Older builds staged imports in the OS cache dir, which Android
  /// evicts under storage pressure — the row then re-read a dead path forever.
  /// Retrying can never help; the user has to re-select the file.
  static const missingSourceError =
      "Source file no longer available — re-select it";

  /// Durable staging directory for files an import downloads on the user's
  /// behalf. Deliberately NOT [getTemporaryDirectory]: Android's cache dir is
  /// evicted by the OS whenever storage runs low, which stranded queued uploads
  /// with a file_path that no longer existed. Application-support is app-private
  /// and never evicted; each staged file is deleted once its upload succeeds.
  static Future<Directory> stagingDir() async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory(p.join(base.path, "upload_staging"));
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    return dir;
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
      "SELECT COUNT(*) AS c FROM uploads WHERE state = 'pending'",
    );
    return (r.first["c"] as int?) ?? 0;
  }

  Future<int> failedCount() async {
    final r = await _db.rawQuery(
      "SELECT COUNT(*) AS c FROM uploads WHERE state = 'failed'",
    );
    return (r.first["c"] as int?) ?? 0;
  }

  /// Recover rows the drain would otherwise never touch again, run at the
  /// start of every drain:
  ///   1. `in_flight` strays — a killed background isolate (Android caps each
  ///      run at a few minutes) leaves a row `in_flight` forever, since
  ///      [nextBatch] only picks `pending`.
  ///   2. attempt-exhausted `pending` rows — [nextBatch] filters
  ///      `attempts < _maxAttempts`, so once a row burned its retries it is
  ///      skipped forever yet still counted by [pendingCount]. Older builds
  ///      lacked the upload timeout, so a flaky run could exhaust hundreds of
  ///      rows that are actually fine. Give them one clean shot now that
  ///      stalls fail fast; genuinely-bad rows will re-exhaust and become
  ///      'failed' (surfacing in the ⚠ list) rather than looping.
  /// Rows already marked [missingSourceError] are never revived — their source
  /// file is gone, so another attempt would just re-read the same dead path.
  /// Returns how many rows were recovered.
  Future<int> recoverStuck() async {
    // Only reclaim in_flight rows whose lease has expired — a row claimed by a
    // live drain in this same process has a fresh in_flight_since, so recovering
    // it here would let two drains upload the same file. A 10-minute lease
    // comfortably exceeds Android's background execution window.
    final leaseCutoff = DateTime.now()
            .subtract(const Duration(minutes: 10))
            .millisecondsSinceEpoch;
    return _db.rawUpdate(
      """
      UPDATE uploads
      SET state = 'pending',
          in_flight_since = NULL,
          attempts = CASE WHEN attempts >= ? THEN 0 ELSE attempts END,
          last_error = CASE WHEN attempts >= ? THEN NULL ELSE last_error END
      WHERE ((state = 'in_flight'
              AND (in_flight_since IS NULL OR in_flight_since < ?))
         OR (state = 'pending' AND attempts >= ?))
        AND (last_error IS NULL OR last_error <> ?)
      """,
      [
        _maxAttempts,
        _maxAttempts,
        leaseCutoff,
        _maxAttempts,
        missingSourceError,
      ],
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

  /// In-progress rows (queued or actively uploading), oldest first — the
  /// order the drain works through them. For the Transfers queue detail view.
  Future<List<UploadQueueEntry>> pendingItems({int limit = 200}) async {
    final rows = await _db.query(
      "uploads",
      where: "state IN ('pending','in_flight')",
      orderBy: "created_at ASC",
      limit: limit,
    );
    return rows.map(UploadQueueEntry.fromRow).toList();
  }

  /// Reset failed rows back to a fresh pending attempt — except rows whose
  /// source file is gone from disk. Re-queuing those burns five more attempts
  /// re-reading the same dead path and lands right back in 'failed', so they
  /// keep the [missingSourceError] message instead. Returns the count actually
  /// re-queued.
  Future<int> retryFailed() async {
    final rows = await _db.query(
      "uploads",
      columns: ["id", "file_path"],
      where: "state = 'failed'",
    );
    final retryable = <int>[];
    final missing = <int>[];
    for (final r in rows) {
      final id = r["id"] as int;
      final path = r["file_path"] as String;
      if (await File(path).exists()) {
        retryable.add(id);
      } else {
        missing.add(id);
      }
    }
    if (missing.isNotEmpty) {
      final ph = List.filled(missing.length, "?").join(",");
      await _db.rawUpdate(
        "UPDATE uploads SET last_error = ? WHERE id IN ($ph)",
        <Object?>[missingSourceError, ...missing],
      );
    }
    if (retryable.isEmpty) return 0;
    final ph = List.filled(retryable.length, "?").join(",");
    return _db.rawUpdate(
      "UPDATE uploads SET state = 'pending', attempts = 0, last_error = NULL "
      "WHERE id IN ($ph)",
      <Object?>[...retryable],
    );
  }

  /// Drop failed rows from the queue entirely. Returns count.
  Future<int> clearFailed() async {
    // Delete each row's staged source first. Staging is now a durable dir the
    // OS never evicts, so dropping the row alone would leak those bytes on the
    // device forever. GUARDED to the staging dirs — a camera-roll pick carries
    // the user's real device path, which we must NOT delete.
    final rows = await _db.query(
      "uploads",
      columns: ["file_path"],
      where: "state = 'failed'",
    );
    final stagingPath = (await stagingDir()).path;
    final tmpPath = (await getTemporaryDirectory()).path;
    for (final r in rows) {
      final path = r["file_path"] as String;
      if (!p.isWithin(stagingPath, path) && !p.isWithin(tmpPath, path)) {
        continue;
      }
      try {
        final f = File(path);
        if (await f.exists()) await f.delete();
      } catch (_) {/* best-effort */}
    }
    return _db.delete("uploads", where: "state = 'failed'");
  }

  /// Atomically claim up to [limit] pending rows → 'in_flight', stamping
  /// in_flight_since so [recoverStuck] won't reclaim a live lease. SELECT +
  /// UPDATE run in one transaction so a parallel drain can't pick the same
  /// rows (mirrors DriveDownloadQueue.claimBatch).
  Future<List<UploadQueueEntry>> nextBatch({int limit = 10}) async {
    return _db.transaction((txn) async {
      final rows = await txn.query(
        "uploads",
        where: "state = ? AND attempts < ?",
        whereArgs: ["pending", _maxAttempts],
        orderBy: "created_at ASC",
        limit: limit,
      );
      if (rows.isEmpty) return const <UploadQueueEntry>[];
      final ids = rows.map((r) => r["id"] as int).toList();
      final ph = List.filled(ids.length, "?").join(",");
      await txn.rawUpdate(
        "UPDATE uploads SET state = 'in_flight', in_flight_since = ? "
        "WHERE id IN ($ph)",
        [DateTime.now().millisecondsSinceEpoch, ...ids],
      );
      return rows.map(UploadQueueEntry.fromRow).toList();
    });
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
    // Resolve the staging dir once so we can safely delete ONLY upload sources
    // we created under it. Camera-roll picks flow through this same queue with
    // the user's REAL device file path, which must never be deleted. The legacy
    // temp dir is still checked so rows staged by older builds are cleaned up
    // too, instead of leaking bytes on the device forever.
    final stagingPath = (await stagingDir()).path;
    final tmpPath = (await getTemporaryDirectory()).path;
    var processed = 0;
    var ok = 0;
    // Bulk imports used to bog down because we processed one upload at a
    // time and a single slow file (network glitch → 120s timeout) blocked
    // every queued file behind it. Run a small fan-out (3 in flight) so a
    // stuck upload only burns its own slot — the other two keep draining.
    const concurrency = 3;
    // Set the re-entrancy flag immediately before the try so the finally that
    // resets it (and closes the client) ALWAYS runs. recoverStuck()/
    // pendingCount() hit the DB (which can throw on a locked/full/corrupt db);
    // if they threw before the try, _draining would stay true forever in this
    // isolate and every later drain() would silently no-op at the guard.
    _draining = true;
    try {
      // Recover rows the drain would otherwise skip forever (stranded in_flight
      // + attempt-exhausted pending) before counting, so they're retried this
      // run instead of the count flooring out.
      await queue.recoverStuck();
      var total = await queue.pendingCount();
      if (total > 0) {
        progress.value = UploadProgress(done: 0, total: total);
      }
      for (;;) {
        final batch = await queue.nextBatch(limit: 30);
        if (batch.isEmpty) {
          // Queue drained — but if a bulk import is still downloading + adding
          // files, hold the drain open (and the progress bar) instead of
          // exiting and re-spawning per file.
          if (feeding) {
            await Future.delayed(const Duration(milliseconds: 600));
            continue;
          }
          break;
        }
        // Grow the total to include files added since the drain started (a
        // bulk import keeps feeding mid-drain), so the bar reads "X of Y"
        // monotonically instead of resetting. pendingCount still includes this
        // batch (rows are marked in_flight just below), so no double-count.
        final known = processed + await queue.pendingCount();
        if (known > total) {
          total = known;
          progress.value = UploadProgress(done: processed, total: total);
        }
        // nextBatch already claimed these rows in_flight atomically, so a
        // parallel foreground drain trigger can't pick the same rows up.
        // Process the batch with bounded concurrency. Dart's single-threaded
        // event loop makes counter increments safe across awaiting futures.
        for (int i = 0; i < batch.length; i += concurrency) {
          final chunk = batch.sublist(
            i,
            i + concurrency > batch.length ? batch.length : i + concurrency,
          );
          await Future.wait(chunk.map((entry) async {
            try {
              final file = File(entry.filePath);
              // Re-hash the bytes we are about to send. entry.sha256 was
              // computed when the file was staged, which can be hours earlier —
              // if anything replaced those bytes since (a re-import writing the
              // same deterministic staging filename), the stored digest is stale
              // and the server rejects the upload with a 409 SHA-256 mismatch
              // forever. Hashing here means the digest always describes the
              // bytes of this attempt.
              final sha256Hex = await hashFile(file);
              // Direct-to-R2: presign → PUT bytes straight to R2 → complete.
              // The bytes never transit the Fonto server; the digest goes along
              // for the server-side integrity check. uploadFileDirect
              // transparently falls back to the legacy multipart route for files
              // over the 5 GiB single-PUT ceiling.
              final asset = await client.uploadFileDirect(
                file,
                virtualPath: entry.virtualPath,
                sha256Hex: sha256Hex,
              );
              await queue._markSuccess(entry.id, asset.id);
              // Best-effort cleanup of the staged source we downloaded for this
              // upload. GUARDED to the staging dir (plus the legacy temp dir) —
              // a camera-roll pick carries the user's real device path, which we
              // must NOT delete.
              if (p.isWithin(stagingPath, entry.filePath) ||
                  p.isWithin(tmpPath, entry.filePath)) {
                try {
                  final f = File(entry.filePath);
                  if (await f.exists()) await f.delete();
                } catch (_) {/* best-effort */}
              }
              ok++;
            } on ApiException catch (e) {
              final terminal = e.status >= 400 &&
                  e.status < 500 &&
                  e.status != 429 &&
                  e.status != 408;
              await queue._markFailure(
                entry.id,
                "${e.status}: ${e.message}",
                terminal: terminal,
              );
            } on FileSystemException catch (e) {
              // Covers PathNotFoundException (its subclass): the source file is
              // gone — an OS-evicted cache staging path from an older build, or
              // a picked file the user deleted. Re-reading the same path can
              // never succeed, so fail TERMINALLY instead of retrying forever.
              final gone = !await File(entry.filePath).exists();
              await queue._markFailure(
                entry.id,
                gone
                    ? missingSourceError
                    : "Could not read source file: ${e.message}",
                // Only a genuinely missing file is unrecoverable. A transient
                // read error (busy disk, mid-stream I/O fault) on a file that
                // still exists must stay retryable — marking it terminal would
                // discard an upload the next attempt could have completed.
                terminal: gone,
              );
            } catch (e) {
              await queue._markFailure(entry.id, e.toString(), terminal: false);
            }
            processed++;
            progress.value = UploadProgress(
              done: processed,
              total: processed > total ? processed : total,
            );
          }));
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
