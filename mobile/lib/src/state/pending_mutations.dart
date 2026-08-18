// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Minimal offline edit queue. The upload + Drive-download queues handle file
// INGEST; this queue handles small per-asset EDIT mutations (favorite + rating
// today) that the user makes while offline. Each row is one PATCH /assets/:id
// body; on reconnect we replay them in order via FontoClient.patchAsset.
//
// Last-write-wins per (asset, field): enqueue collapses an existing pending
// row for the same asset+field rather than stacking toggles, so flipping a
// favorite twice offline replays once with the final value. Best-effort — a
// permanent 4xx drops the row (the local optimistic state already reflects the
// user's intent; we don't want a poison row to wedge the queue).

import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:sqflite/sqflite.dart";

import "../api/fonto_client.dart";
import "auth_store.dart";

class PendingMutations {
  PendingMutations._(this._db);

  final Database _db;
  static PendingMutations? _instance;

  static Future<PendingMutations> open() async {
    if (_instance != null) return _instance!;
    final docs = await getApplicationDocumentsDirectory();
    final dbPath = p.join(docs.path, "fonto-pending-mutations.db");
    final db = await openDatabase(
      dbPath,
      version: 1,
      onCreate: (db, _) async {
        await db.execute("""
          CREATE TABLE pending_mutations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(asset_id, field)
          )
        """);
      },
    );
    _instance = PendingMutations._(db);
    return _instance!;
  }

  /// Queue (or collapse) one field edit for an asset. [value] is the JSON-
  /// scalar string form: "true"/"false" for isFavorite, the integer text for
  /// rating. UNIQUE(asset_id, field) + REPLACE = last-write-wins.
  /// Returns true if the row was persisted, false if the local write failed
  /// (so the caller can avoid misreporting "Saved offline").
  Future<bool> enqueue({
    required String assetId,
    required String field,
    required String value,
  }) async {
    try {
      await _db.insert(
        "pending_mutations",
        {
          "asset_id": assetId,
          "field": field,
          "value": value,
          "created_at": DateTime.now().millisecondsSinceEpoch,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<int> pendingCount() async {
    final r = await _db.rawQuery("SELECT COUNT(*) c FROM pending_mutations");
    return (r.first["c"] as int?) ?? 0;
  }

  /// Replay every queued edit in insertion order, via the asset PATCH endpoint.
  /// A row is deleted once it lands (2xx) or on a permanent 4xx (the local
  /// optimistic state already reflects intent). Transient/5xx/network errors
  /// leave the row for the next pass. Returns the number successfully applied.
  /// Re-entrancy guard (mirrors UploadQueue/DriveDownloadQueue). Two near-
  /// simultaneous reconnect/resume triggers would otherwise both read the same
  /// rows and replay them, double-firing every PATCH and racing the per-row
  /// deletes. Set synchronously after the guard so no await can slip a second
  /// drain past the check.
  static bool _draining = false;

  Future<int> drain(AuthStore auth) async {
    if (_draining) return 0;
    _draining = true;
    final client = FontoClient(auth);
    var applied = 0;
    try {
      if (await pendingCount() == 0) return applied;
      final rows = await _db.query("pending_mutations", orderBy: "id ASC");
      for (final r in rows) {
        final rowId = r["id"] as int;
        final assetId = r["asset_id"] as String;
        final field = r["field"] as String;
        final value = r["value"] as String;
        final body = _bodyFor(field, value);
        if (body == null) {
          await _db.delete("pending_mutations",
              where: "id = ?", whereArgs: [rowId]);
          continue;
        }
        try {
          await client.patchAsset(assetId, body);
          await _db.delete("pending_mutations",
              where: "id = ?", whereArgs: [rowId]);
          applied++;
        } on ApiException catch (e) {
          // Permanent client error (gone / forbidden / bad request) — drop it.
          if (e.status >= 400 && e.status < 500) {
            await _db.delete("pending_mutations",
                where: "id = ?", whereArgs: [rowId]);
          } else {
            // 5xx — stop; retry the whole batch on the next reconnect.
            break;
          }
        } catch (_) {
          // Network down again mid-drain — leave the rest for next time.
          break;
        }
      }
    } finally {
      client.close();
      _draining = false;
    }
    return applied;
  }

  static Map<String, dynamic>? _bodyFor(String field, String value) {
    switch (field) {
      case "isFavorite":
        return {"isFavorite": value == "true"};
      case "rating":
        final n = int.tryParse(value);
        return n == null ? null : {"rating": n};
      default:
        return null;
    }
  }
}
