// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// On-device asset METADATA cache. Without this the library grid is fetched
// fresh every launch, so going offline = a blank grid. We persist the asset
// rows (+ their last-known signed thumbnail/preview URLs) on every successful
// fetch, then render the grid straight from SQLite when the network is down.
//
// Pagination mirrors the server keyset: order by COALESCE(captured_at,
// created_at) DESC, id DESC — identical to `sort=captured` — so offline
// infinite-scroll behaves like the online one.

import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:sqflite/sqflite.dart";

import "../api/models.dart";

/// One offline page: the asset rows plus the (possibly stale) signed thumbnail
/// URLs they were last seen with. The stale URL is fine — the image layer keys
/// its disk cache by asset id, so cached bytes render regardless.
class CachedPage {
  CachedPage({required this.assets, required this.thumbs, required this.previews});
  final List<Asset> assets;
  final Map<String, String> thumbs;
  final Map<String, String> previews;
}

class AssetCache {
  AssetCache._(this._db);

  final Database _db;
  static AssetCache? _instance;

  static Future<AssetCache> open() async {
    if (_instance != null) return _instance!;
    final docs = await getApplicationDocumentsDirectory();
    final dbPath = p.join(docs.path, "fonto-assets.db");
    final db = await openDatabase(
      dbPath,
      version: 1,
      onCreate: (db, _) async {
        await db.execute("""
          CREATE TABLE cached_assets (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            captured_at INTEGER,
            description TEXT,
            classification TEXT,
            directory_path TEXT,
            is_favorite INTEGER,
            rating INTEGER,
            processing_state TEXT,
            width_px INTEGER,
            height_px INTEGER,
            thumb_url TEXT,
            preview_url TEXT,
            sort_ts INTEGER NOT NULL,
            cached_at INTEGER NOT NULL
          )
        """);
        // Keyset page scan: newest sort_ts first, id as the tiebreak.
        await db.execute(
          "CREATE INDEX cached_assets_sort_idx ON cached_assets(sort_ts DESC, id DESC)",
        );
      },
    );
    _instance = AssetCache._(db);
    return _instance!;
  }

  static int _ms(DateTime d) => d.millisecondsSinceEpoch;

  /// Upsert a batch of fetched assets + their signed URLs. Idempotent
  /// (INSERT OR REPLACE on the id PK). A null url leaves the existing one.
  Future<void> upsertAll(
    List<Asset> assets, {
    Map<String, String> thumbs = const {},
    Map<String, String> previews = const {},
  }) async {
    if (assets.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final batch = _db.batch();
    for (final a in assets) {
      // Only the fully-shaped timeline rows are cached, and they always carry
      // a created_at (the column is NOT NULL). Skip the trimmed collection/
      // person rows if one ever reaches here rather than fabricate a date.
      final createdAt = a.createdAt;
      if (createdAt == null) continue;
      final sortTs = _ms(a.capturedAt ?? createdAt);
      batch.insert(
        "cached_assets",
        {
          "id": a.id,
          "filename": a.filename,
          "mime_type": a.mimeType,
          "size_bytes": a.sizeBytes ?? 0,
          "created_at": _ms(createdAt),
          "captured_at": a.capturedAt == null ? null : _ms(a.capturedAt!),
          "description": a.description,
          "classification": a.classification,
          "directory_path": a.directoryPath,
          "is_favorite": a.isFavorite == null ? null : (a.isFavorite! ? 1 : 0),
          "rating": a.rating,
          "processing_state": a.processingState,
          "width_px": a.widthPx,
          "height_px": a.heightPx,
          "thumb_url": thumbs[a.id],
          "preview_url": previews[a.id],
          "sort_ts": sortTs,
          "cached_at": now,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  /// Offline page read. [beforeSortTs]/[beforeId] = keyset cursor (null = first
  /// page). [folderPrefix] mirrors the online `directoryPathPrefix` filter.
  Future<CachedPage> queryPage({
    int? beforeSortTs,
    String? beforeId,
    String? folderPrefix,
    int limit = 60,
  }) async {
    final where = <String>[];
    final args = <Object?>[];
    if (beforeSortTs != null && beforeId != null) {
      where.add("(sort_ts < ? OR (sort_ts = ? AND id < ?))");
      args.addAll([beforeSortTs, beforeSortTs, beforeId]);
    }
    if (folderPrefix != null && folderPrefix.isNotEmpty) {
      // LIKE treats _ and % as wildcards, so a real folder segment containing
      // one (e.g. "/My_Trip") would also match sibling folders ("/MyXTrip").
      // Escape them (backslash first) and declare ESCAPE so the prefix matches
      // literally — parameterization alone doesn't stop LIKE-pattern bleed.
      final escaped = folderPrefix
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_");
      where.add("directory_path LIKE ? ESCAPE '\\'");
      args.add("$escaped%");
    }
    final rows = await _db.query(
      "cached_assets",
      where: where.isEmpty ? null : where.join(" AND "),
      whereArgs: args.isEmpty ? null : args,
      orderBy: "sort_ts DESC, id DESC",
      limit: limit,
    );
    final assets = <Asset>[];
    final thumbs = <String, String>{};
    final previews = <String, String>{};
    for (final r in rows) {
      final id = r["id"] as String;
      assets.add(_fromRow(r));
      final t = r["thumb_url"] as String?;
      final pv = r["preview_url"] as String?;
      if (t != null && t.isNotEmpty) thumbs[id] = t;
      if (pv != null && pv.isNotEmpty) previews[id] = pv;
    }
    return CachedPage(assets: assets, thumbs: thumbs, previews: previews);
  }

  Future<int> count() async {
    final r = await _db.rawQuery("SELECT COUNT(*) c FROM cached_assets");
    return (r.first["c"] as int?) ?? 0;
  }

  /// Last-known signed image URL for a single asset — preview if we have one,
  /// else the thumb. Returns null when the asset isn't cached or carries no
  /// URL. Used by the detail viewer to render offline when the live presign
  /// fetch fails.
  Future<String?> urlForAsset(String id) async {
    final rows = await _db.query(
      "cached_assets",
      columns: ["thumb_url", "preview_url"],
      where: "id = ?",
      whereArgs: [id],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final preview = rows.first["preview_url"] as String?;
    if (preview != null && preview.isNotEmpty) return preview;
    final thumb = rows.first["thumb_url"] as String?;
    if (thumb != null && thumb.isNotEmpty) return thumb;
    return null;
  }

  static Asset _fromRow(Map<String, Object?> r) {
    DateTime? at(String k) {
      final v = r[k] as int?;
      return v == null ? null : DateTime.fromMillisecondsSinceEpoch(v);
    }

    final fav = r["is_favorite"] as int?;
    return Asset(
      id: r["id"] as String,
      filename: r["filename"] as String,
      mimeType: r["mime_type"] as String,
      sizeBytes: r["size_bytes"] as int,
      createdAt: at("created_at")!,
      capturedAt: at("captured_at"),
      description: r["description"] as String?,
      classification: r["classification"] as String?,
      directoryPath: r["directory_path"] as String?,
      isFavorite: fav == null ? null : fav == 1,
      rating: r["rating"] as int?,
      processingState: r["processing_state"] as String?,
      widthPx: r["width_px"] as int?,
      heightPx: r["height_px"] as int?,
    );
  }
}
