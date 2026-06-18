// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// On-device cache of the manual-collection (album) list. Mirrors AssetCache:
// without it the Collections → Albums tab is fetched fresh every launch, so
// going offline = a blank tab. We persist the rows on every successful
// listCollections() fetch, then render straight from SQLite when the network
// is down.
//
// The Collection wire model carries only id/name/description/timestamps today
// (no cover/count yet); the table reserves nullable cover_url + item_count
// columns so a richer payload can populate them later without a schema bump.

import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:sqflite/sqflite.dart";

import "../api/models.dart";

class CollectionCache {
  CollectionCache._(this._db);

  final Database _db;
  static CollectionCache? _instance;

  static Future<CollectionCache> open() async {
    if (_instance != null) return _instance!;
    final docs = await getApplicationDocumentsDirectory();
    final dbPath = p.join(docs.path, "fonto-collections.db");
    final db = await openDatabase(
      dbPath,
      version: 1,
      onCreate: (db, _) async {
        await db.execute("""
          CREATE TABLE cached_collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            cover_url TEXT,
            item_count INTEGER,
            sort_ts INTEGER NOT NULL,
            cached_at INTEGER NOT NULL
          )
        """);
        await db.execute(
          "CREATE INDEX cached_collections_sort_idx "
          "ON cached_collections(sort_ts DESC, id DESC)",
        );
      },
    );
    _instance = CollectionCache._(db);
    return _instance!;
  }

  /// Replace the cached album list with the latest fetch. Idempotent — a
  /// fresh fetch fully reflects the server, so we clear stale rows (albums the
  /// user deleted) and re-insert. Wrapped in a transaction so a reader never
  /// sees an empty table mid-write.
  Future<void> upsertAll(List<Collection> collections) async {
    await _db.transaction((txn) async {
      await txn.delete("cached_collections");
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final c in collections) {
        final sortTs =
            (c.updatedAt ?? c.createdAt)?.millisecondsSinceEpoch ?? now;
        await txn.insert(
          "cached_collections",
          {
            "id": c.id,
            "name": c.name,
            "description": c.description,
            "cover_url": null,
            "item_count": null,
            "sort_ts": sortTs,
            "cached_at": now,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  }

  /// Read the cached album list, newest first (id tiebreak).
  Future<List<Collection>> all() async {
    final rows = await _db.query(
      "cached_collections",
      orderBy: "sort_ts DESC, id DESC",
    );
    return rows
        .map((r) => Collection(
              id: r["id"] as String,
              name: r["name"] as String,
              description: r["description"] as String?,
            ))
        .toList();
  }
}
