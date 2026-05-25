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

  Future<List<Asset>> listAssets({String? mime, int? limit}) async {
    final query = <String, String>{};
    if (mime != null) query["mime"] = mime;
    if (limit != null) query["limit"] = "$limit";
    final j = await _getJson("/api/v1/assets", query.isEmpty ? null : query);
    final raw = (j["assets"] as List).cast<Map<String, dynamic>>();
    return raw.map(Asset.fromJson).toList();
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

  void close() => _http.close();
}
