// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Thin HTTP client around the Fonto /api/v1 surface. PAT goes in the
// Authorization header; every error path collapses into ApiException
// so screens have one catch-block shape to render.

import "dart:convert";
import "dart:io";
import "package:http/http.dart" as http;
import "package:path/path.dart" as p;

import "../state/auth_store.dart";
import "models.dart";

class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => "ApiException($status): $message";
}

class FontoClient {
  FontoClient(this.auth, {http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  final AuthStore auth;
  final http.Client _http;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse("${auth.baseUrl}$path").replace(queryParameters: query);

  Map<String, String> get _headers => {
        "Authorization": "Bearer ${auth.pat ?? ""}",
        "Accept": "application/json",
      };

  Future<Map<String, dynamic>> _getJson(String path,
      [Map<String, String>? query]) async {
    final res = await _http.get(_uri(path, query), headers: _headers);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    return json.decode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> _postJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    final res = await _http.post(
      _uri(path),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    return json.decode(res.body) as Map<String, dynamic>;
  }

  String _extractError(String body) {
    try {
      final j = json.decode(body) as Map<String, dynamic>;
      return (j["error"] as String?) ?? body;
    } catch (_) {
      return body;
    }
  }

  /// Round-trips /api/v1/stats. Doubles as the "is this PAT valid?"
  /// probe from the login screen.
  Future<WorkspaceStats> stats() async {
    final j = await _getJson("/api/v1/stats");
    return WorkspaceStats.fromJson(j);
  }

  /// One page of assets ordered (createdAt DESC, id DESC). Pass back
  /// `nextCursor` to fetch the next page. `directoryPathPrefix` filters
  /// to a folder subtree (e.g. "/Photos").
  Future<AssetPage> listAssets({
    String? mime,
    int limit = 60,
    AssetCursor? after,
    String? directoryPathPrefix,
  }) async {
    final query = <String, String>{"limit": "$limit"};
    if (mime != null) query["mime"] = mime;
    if (after != null) {
      query["createdBefore"] = after.createdBefore;
      query["idBefore"] = after.idBefore;
    }
    if (directoryPathPrefix != null && directoryPathPrefix.isNotEmpty) {
      query["directoryPathPrefix"] = directoryPathPrefix;
    }
    final j = await _getJson("/api/v1/assets", query);
    final raw = (j["assets"] as List).cast<Map<String, dynamic>>();
    final cursorJson = j["nextCursor"] as Map<String, dynamic>?;
    return AssetPage(
      assets: raw.map(Asset.fromJson).toList(),
      nextCursor: cursorJson == null ? null : AssetCursor.fromJson(cursorJson),
    );
  }

  /// Text search across filename / description / OCR. Single page; the
  /// search endpoint doesn't paginate today.
  Future<List<Asset>> search(String q) async {
    final j = await _getJson("/api/v1/search", {"q": q});
    final raw = (j["assets"] as List).cast<Map<String, dynamic>>();
    return raw.map(Asset.fromJson).toList();
  }

  /// Folder tree — flat list `[{path, assetCount}]` plus a separate
  /// `rootAssetCount` for assets with NULL directoryPath. Materialised
  /// into a nested tree client-side.
  Future<FolderTree> folderTree() async {
    final j = await _getJson("/api/v1/folders/tree");
    final paths = (j["paths"] as List)
        .cast<Map<String, dynamic>>()
        .map(FolderLeaf.fromJson)
        .toList();
    return FolderTree(
      paths: paths,
      rootAssetCount: (j["rootAssetCount"] as num?)?.toInt() ?? 0,
    );
  }

  /// Manual albums. Full list; the endpoint doesn't paginate.
  Future<List<Collection>> listCollections() async {
    final j = await _getJson("/api/v1/collections");
    final raw = (j["collections"] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return raw.map(Collection.fromJson).toList();
  }

  /// Saved-search collections. Full list; no pagination.
  Future<List<SmartCollection>> listSmartCollections() async {
    final j = await _getJson("/api/v1/smart-collections");
    final raw = (j["smartCollections"] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return raw.map(SmartCollection.fromJson).toList();
  }

  /// Projects. Full list; no pagination.
  Future<List<Project>> listProjects() async {
    final j = await _getJson("/api/v1/projects");
    final raw =
        (j["projects"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(Project.fromJson).toList();
  }

  /// Stacks (near-duplicate groups). Full list; no pagination.
  Future<List<AssetStack>> listStacks() async {
    final j = await _getJson("/api/v1/stacks");
    final raw =
        (j["stacks"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(AssetStack.fromJson).toList();
  }

  /// Batched presigned-URL fetch. Mirrors the web grid and CLI download
  /// flow: ids → { id: presignedUrl }. Variant is one of thumb /
  /// preview / original.
  Future<Map<String, String>> assetUrls(
    List<String> ids, {
    String variant = "thumb",
  }) async {
    final j = await _postJson(
      "/api/v1/assets/urls",
      {"ids": ids, "variant": variant},
    );
    final urls = (j["urls"] as Map).cast<String, dynamic>();
    return urls.map((k, v) => MapEntry(k, v as String));
  }

  /// Uploads a single file via multipart. `virtualPath` becomes
  /// X-Fonto-Path (the directory_path the server records).
  Future<Asset> uploadFile(File file, {String virtualPath = "/"}) async {
    final req = http.MultipartRequest("POST", _uri("/api/v1/assets"))
      ..headers.addAll(_headers)
      ..headers["X-Fonto-Path"] = virtualPath
      ..fields["source"] = "mobile"
      ..files.add(await http.MultipartFile.fromPath(
        "file",
        file.path,
        filename: p.basename(file.path),
      ));
    final streamed = await _http.send(req);
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    final j = json.decode(res.body) as Map<String, dynamic>;
    return Asset.fromJson(j["asset"] as Map<String, dynamic>);
  }

  /// Generic PATCH /assets/:id. Server accepts subset of
  /// { trash, restore, isFavorite, rating, directoryPath }. Returns
  /// the refreshed asset row.
  Future<Asset> patchAsset(String id, Map<String, dynamic> body) async {
    final res = await _http.patch(
      _uri("/api/v1/assets/$id"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    final j = json.decode(res.body) as Map<String, dynamic>;
    return Asset.fromJson(j["asset"] as Map<String, dynamic>);
  }

  Future<Asset> setFavorite(String id, bool isFavorite) =>
      patchAsset(id, {"isFavorite": isFavorite});

  Future<Asset> trashAsset(String id) => patchAsset(id, {"trash": true});

  Future<Asset> restoreAsset(String id) => patchAsset(id, {"restore": true});

  /// POST /shares — mints a public share link for one asset. Returns
  /// the full URL ready for OS share-intent.
  Future<String> createAssetShare(String id) async {
    final j = await _postJson("/api/v1/shares", {
      "targetType": "asset",
      "targetId": id,
    });
    return j["url"] as String;
  }

  /// Resolves a public share slug/token to { targetType, targetId }.
  /// Throws ApiException(403) for password-protected shares, 404 for
  /// invalid/expired links. Used by the App Links handler in main.dart.
  Future<({String targetType, String targetId})> resolveShare(String slug) async {
    final res = await _http.get(
      _uri("/api/v1/shares/resolve", {"slug": slug}),
      headers: _headers,
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    final j = json.decode(res.body) as Map<String, dynamic>;
    return (
      targetType: j["targetType"] as String,
      targetId: j["targetId"] as String,
    );
  }

  /// Fetches a single asset by id. Used after share resolution.
  Future<Asset> getAsset(String id) async {
    final j = await _getJson("/api/v1/assets/$id");
    return Asset.fromJson(j["asset"] as Map<String, dynamic>);
  }

  void close() => _http.close();
}
