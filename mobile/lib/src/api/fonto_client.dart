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

  Future<Map<String, dynamic>> _putJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    final res = await _http.put(
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

  /// One page of assets ordered by capture date (COALESCE(captured_at,
  /// created_at) DESC, id DESC) so photos and documents land in their real
  /// meta-data order, not ingest order. Pass back `nextCursor` to fetch the
  /// next page. `directoryPathPrefix` filters to a folder subtree.
  Future<AssetPage> listAssets({
    String? mime,
    int limit = 60,
    AssetCursor? after,
    String? directoryPathPrefix,
    bool hasGeo = false,
    bool favorite = false,
    String? kind,
    String? lifecycle,
    String? place,
  }) async {
    final query = <String, String>{"limit": "$limit", "sort": "captured"};
    if (mime != null) query["mime"] = mime;
    if (hasGeo) query["hasGeo"] = "1";
    if (favorite) query["favorite"] = "1";
    if (kind != null && kind.isNotEmpty) query["kind"] = kind;
    if (lifecycle != null && lifecycle.isNotEmpty) query["lifecycle"] = lifecycle;
    if (place != null && place.isNotEmpty) query["place"] = place;
    if (after != null) {
      query["capturedBefore"] = after.before;
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

  /// Full-library month buckets (newest first) — `[{month: "YYYY-MM",
  /// count: int}]`. Drives the mobile timeline's right-rail scrubber so the
  /// thumb position represents the whole library, not just loaded pages.
  Future<List<AssetBucket>> assetBuckets() async {
    final j = await _getJson("/api/v1/assets/buckets");
    final raw = (j["buckets"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(AssetBucket.fromJson).toList();
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

  /// Collections belonging to a project. GET /projects/:id returns the
  /// project plus its collections; the project-detail screen lists those.
  Future<List<Collection>> projectCollections(String projectId) async {
    final j = await _getJson("/api/v1/projects/$projectId");
    final raw = (j["collections"] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return raw.map(Collection.fromJson).toList();
  }

  /// Assets in a manual collection. GET /collections/:id/assets → full rows.
  Future<List<Asset>> assetsByCollection(String collectionId) async {
    final j = await _getJson("/api/v1/collections/$collectionId/assets");
    final raw =
        (j["assets"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw
        .map((a) => Asset.fromJson({
              "sizeBytes": 0,
              "createdAt": DateTime.now().toIso8601String(),
              ...a,
            }))
        .toList();
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

  /// Phase 3 (faces/UX) — resolve a relative API URL endpoint that returns a
  /// signed object URL as `{ "url": "..." }`. Used for the dedicated face crop
  /// (`Person.coverFaceCropUrl`, `AssetFace.faceCropUrl`), which point at
  /// /api/v1/assets/:id/url?variant=face&faceId=… . Returns null on failure so
  /// callers can fall back to a zoomed thumb.
  Future<String?> resolveSignedUrl(String relativePath) async {
    try {
      final j = await _getJson(relativePath);
      return j["url"] as String?;
    } catch (_) {
      return null;
    }
  }

  /// On-demand HLS manifest for a video asset. Returns state "ready" with
  /// a relative `playlistUrl` (auth-gated proxy) once transcoded, or
  /// "transcoding" (202, kicks off the job) — poll until ready. The
  /// player resolves playlistUrl against [auth.baseUrl] and sends the PAT
  /// on every segment fetch.
  Future<HlsManifest> assetHls(String id) async {
    final j = await _getJson("/api/v1/assets/$id/hls");
    return HlsManifest.fromJson(j);
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
    // Bound each upload. Without this, a stalled connection on one file
    // hangs the serial drain forever (the file sits `in_flight`, the queue
    // never advances). On timeout this throws TimeoutException, which the
    // drain treats as a retryable failure and moves on to the next file.
    const uploadTimeout = Duration(seconds: 120);
    final streamed = await _http.send(req).timeout(uploadTimeout);
    final res =
        await http.Response.fromStream(streamed).timeout(uploadTimeout);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    final j = json.decode(res.body) as Map<String, dynamic>;
    return Asset.fromJson(j["asset"] as Map<String, dynamic>);
  }

  /// Direct-to-R2 upload. Bytes go client → R2 via a presigned PUT and never
  /// transit the Fonto server:
  ///   1. POST /api/v1/uploads/presign           → { assetId, uploadUrl, key }
  ///   2. PUT  <uploadUrl>  (raw bytes, no auth)  → object lands in R2
  ///   3. POST /api/v1/uploads/{assetId}/complete → server finalizes the row
  ///
  /// `virtualPath` becomes the directory_path the server records. `sha256Hex`
  /// is the lowercase-hex digest the upload queue already computed for its
  /// dedupe key — passed through so the server can trust it (when
  /// SKIP_SERVER_CHECKSUM is on) and reconcile integrity.
  ///
  /// Falls back to the legacy multipart [uploadFile] when the file exceeds the
  /// 5 GiB single-PUT ceiling (presign returns 413 in that case) — multipart
  /// presigned upload is not implemented yet.
  Future<Asset> uploadFileDirect(
    File file, {
    String virtualPath = "/",
    String? sha256Hex,
    String source = "mobile",
  }) async {
    final len = await file.length();
    final mimeType = _guessMimeType(file.path);

    // Step 1: presign.
    final presignRes = await _http.post(
      _uri("/api/v1/uploads/presign"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({
        "filename": p.basename(file.path),
        "mimeType": mimeType,
        "sizeBytes": len,
        if (sha256Hex != null) "sha256": sha256Hex,
        if (virtualPath.isNotEmpty) "path": virtualPath,
      }),
    );
    // 413 = over the 5 GiB single-PUT ceiling → fall back to multipart.
    if (presignRes.statusCode == 413) {
      return uploadFile(file, virtualPath: virtualPath);
    }
    if (presignRes.statusCode < 200 || presignRes.statusCode >= 300) {
      throw ApiException(presignRes.statusCode, _extractError(presignRes.body));
    }
    final presign = json.decode(presignRes.body) as Map<String, dynamic>;
    final assetId = presign["assetId"] as String;
    final uploadUrl = presign["uploadUrl"] as String;
    final putHeaders =
        (presign["headers"] as Map<String, dynamic>?)?.cast<String, String>() ??
            {"Content-Type": mimeType};

    // Step 2: PUT raw bytes straight to R2. NO auth header — the presigned URL
    // carries its own signature; and the Content-Type MUST equal what was
    // signed or R2 rejects the PUT. Streamed so we don't buffer the whole file.
    const uploadTimeout = Duration(seconds: 120);
    final putReq = http.StreamedRequest("PUT", Uri.parse(uploadUrl))
      ..headers.addAll(putHeaders)
      ..contentLength = len;
    // Pump the file into the request sink.
    final pump = file.openRead().listen(
          putReq.sink.add,
          onDone: putReq.sink.close,
          onError: putReq.sink.addError,
          cancelOnError: true,
        );
    final http.StreamedResponse putStreamed;
    try {
      putStreamed = await _http.send(putReq).timeout(uploadTimeout);
    } finally {
      await pump.cancel();
    }
    final putRes =
        await http.Response.fromStream(putStreamed).timeout(uploadTimeout);
    if (putRes.statusCode < 200 || putRes.statusCode >= 300) {
      throw ApiException(putRes.statusCode, "R2 PUT failed: ${putRes.statusCode}");
    }

    // Step 3: finalize.
    final completeRes = await _http.post(
      _uri("/api/v1/uploads/$assetId/complete"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"source": source}),
    );
    if (completeRes.statusCode < 200 || completeRes.statusCode >= 300) {
      throw ApiException(completeRes.statusCode, _extractError(completeRes.body));
    }
    final j = json.decode(completeRes.body) as Map<String, dynamic>;
    return Asset.fromJson(j["asset"] as Map<String, dynamic>);
  }

  /// Best-effort MIME from the file extension. The server re-sniffs the magic
  /// bytes on /complete (detectMime), so this only needs to be close enough
  /// for the presigned Content-Type — octet-stream is a safe default.
  static String _guessMimeType(String path) {
    final ext = p.extension(path).toLowerCase();
    switch (ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".png":
        return "image/png";
      case ".gif":
        return "image/gif";
      case ".webp":
        return "image/webp";
      case ".heic":
      case ".heif":
        return "image/heic";
      case ".mp4":
      case ".m4v":
        return "video/mp4";
      case ".mov":
        return "video/quicktime";
      case ".pdf":
        return "application/pdf";
      default:
        return "application/octet-stream";
    }
  }

  /// Phase 6.4 — register this device's FCM token (204 on success; the
  /// server upserts by (user, deviceId)). `platform` ∈ android|ios|web.
  /// Caller (the firebase_messaging wiring, pending the Firebase gate)
  /// supplies the FCM token + a stable per-install deviceId.
  Future<void> registerPushToken({
    required String deviceId,
    required String token,
    String platform = "android",
  }) async {
    final res = await _http.post(
      _uri("/api/v1/notifications/push-token"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({
        "deviceId": deviceId,
        "token": token,
        "platform": platform,
      }),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
  }

  /// Phase 6.4 — deregister this device (called on sign-out). Idempotent;
  /// returns 204 even if the token was already gone.
  Future<void> deregisterPushToken({required String deviceId}) async {
    final res = await _http.delete(
      _uri("/api/v1/notifications/push-token"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"deviceId": deviceId}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
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

  /// Re-run the full recognition pipeline (OCR, labels, description, faces)
  /// on a single asset. The server resets it to processing and re-enqueues.
  Future<void> reprocessAsset(String id) async {
    await _postJson("/api/v1/assets/$id/reprocess", const {});
  }

  /// Bulk re-scan the workspace. `scope` ∈ all|images|failed. Returns the
  /// number of assets queued.
  Future<int> reprocessWorkspace({String scope = "all"}) async {
    final j = await _postJson("/api/v1/workspace/reprocess", {"scope": scope});
    return (j["queued"] as num?)?.toInt() ?? 0;
  }

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

  /// One page of the workspace activity feed, newest-first. Pass back
  /// `nextCursor` (an ISO timestamp) as `createdBefore` for the next page.
  Future<ActivityPage> listActivity({String? createdBefore, int limit = 50}) async {
    final query = <String, String>{"limit": "$limit"};
    if (createdBefore != null) query["createdBefore"] = createdBefore;
    final j = await _getJson("/api/v1/workspace/activity", query);
    final raw = (j["events"] as List? ?? const []).cast<Map<String, dynamic>>();
    return ActivityPage(
      events: raw.map(ActivityEvent.fromJson).toList(),
      nextCursor: j["nextCursor"] as String?,
    );
  }

  /// Face clusters (Explore → People). Full list, ordered by instance
  /// count desc server-side; no pagination.
  /// Counts behind the Collections screen's utility tiles. Indexed COUNTs
  /// for { favorites, trash, screenshots, archived, documents }.
  Future<CollectionsStats> collectionsStats() async {
    final j = await _getJson("/api/v1/collections/stats");
    return CollectionsStats.fromJson(j);
  }

  /// Reverse-geocoded place groups for the Collections screen's Places
  /// section. Sorted by count desc; each group exposes up to 4 preview
  /// asset IDs for a 2×2 thumbnail mosaic (URLs resolved via [assetUrls]).
  Future<List<PlaceGroup>> places() async {
    final j = await _getJson("/api/v1/places");
    final raw = (j["places"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(PlaceGroup.fromJson).toList();
  }

  /// Place clusters WITH centroid coordinates (lat/lng) + cover asset, for the
  /// Places map and pins. Distinct from [places] (legacy, coords-less). Mirrors
  /// GET /api/v1/assets/places. Drill into a place's photos with
  /// `listAssets(place: name)`.
  Future<List<GeoPlace>> geoPlaces() async {
    final j = await _getJson("/api/v1/assets/places");
    final raw = (j["places"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(GeoPlace.fromJson).toList();
  }

  Future<List<Person>> listPersons() async {
    final j = await _getJson("/api/v1/persons");
    final raw = (j["persons"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(Person.fromJson).toList();
  }

  /// Most-used labels/tags (Explore → Things), each with a count + sample
  /// asset for a thumbnail. Ordered by count desc server-side.
  Future<List<TopTag>> topTags({int limit = 48}) async {
    final j = await _getJson("/api/v1/tags/top", {"limit": "$limit"});
    final raw = (j["tags"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(TopTag.fromJson).toList();
  }

  /// Assets carrying a given tag (Things drill-in). Uses the search endpoint's
  /// tag filter; returns up to the server's cap, no pagination.
  Future<List<Asset>> assetsByTag(String tagId) async {
    final j = await _getJson("/api/v1/search", {"tagId": tagId});
    final raw = (j["assets"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(Asset.fromJson).toList();
  }

  Future<List<Asset>> assetsByPerson(String personId) async {
    final j = await _getJson(
      "/api/v1/persons/$personId/faces",
      {"limit": "200"},
    );
    final faces = (j["faces"] as List? ?? const []).cast<Map<String, dynamic>>();
    final seen = <String>{};
    final assets = <Asset>[];
    for (final f in faces) {
      final a = f["asset"] as Map<String, dynamic>?;
      if (a == null) continue;
      final id = a["id"] as String?;
      if (id == null || !seen.add(id)) continue;
      assets.add(Asset.fromJson({
        "sizeBytes": 0,
        "createdAt": DateTime.now().toIso8601String(),
        ...a,
      }));
    }
    return assets;
  }

  Future<List<AssetFace>> assetFaces(String assetId) async {
    final j = await _getJson("/api/v1/assets/$assetId/faces");
    final raw = (j["faces"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(AssetFace.fromJson).toList();
  }

  Future<void> assignFace(String faceId, String? personId) async {
    final res = await _http.patch(
      _uri("/api/v1/faces/$faceId"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"person_id": personId}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
  }

  /// Ignore (hide) or restore a person cluster. Mirrors web
  /// PATCH /persons/:id { hidden }. The server cascades `hidden` to the
  /// person's faces, so the cluster leaves (or re-enters) the People grid.
  Future<void> setPersonHidden(String personId, bool hidden) async {
    final res = await _http.patch(
      _uri("/api/v1/persons/$personId"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"hidden": hidden}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
  }

  /// Hide or restore a single face. PATCH /faces/:id { hidden }.
  Future<void> setFaceHidden(String faceId, bool hidden) async {
    final res = await _http.patch(
      _uri("/api/v1/faces/$faceId"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"hidden": hidden}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
  }

  /// Ignore or restore every face on a photo.
  /// PATCH /assets/:id/faces-ignored { ignored }.
  Future<void> setAssetFacesIgnored(String assetId, bool ignored) async {
    final res = await _http.patch(
      _uri("/api/v1/assets/$assetId/faces-ignored"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"ignored": ignored}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
  }

  /// The Ignored review surface: hidden persons, ignored photos, and
  /// individually-hidden faces. Mirrors GET /api/v1/faces/ignored.
  Future<IgnoredData> listIgnored() async {
    final j = await _getJson("/api/v1/faces/ignored");
    return IgnoredData.fromJson(j);
  }

  Future<Person> createPerson({required String name}) async {
    final j = await _postJson("/api/v1/persons", {"name": name});
    return Person.fromJson(j["person"] as Map<String, dynamic>);
  }

  /// Update (or clear) a person's name. Passing `null` (or an empty string)
  /// clears the name — the PATCH route treats null/empty as "unname".
  /// Phase 3 (faces/UX): the param is nullable so the app can remove a name,
  /// which was previously impossible (non-nullable param + name != null guards).
  Future<Person> updatePersonName(String personId, String? name) async {
    final res = await _http.patch(
      _uri("/api/v1/persons/$personId"),
      headers: {..._headers, "Content-Type": "application/json"},
      body: json.encode({"name": name}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    final j = json.decode(res.body) as Map<String, dynamic>;
    return Person.fromJson(j["person"] as Map<String, dynamic>);
  }

  Future<List<FaceSuggestion>> faceSuggestions(String faceId) async {
    final j = await _getJson("/api/v1/faces/$faceId/suggestions");
    final raw = (j["suggestions"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(FaceSuggestion.fromJson).toList();
  }

  /// Merge [sourceId] into [intoId]: every face moves to the target person and
  /// the source person is deleted. Mirrors the web person-detail merge action.
  /// Returns the auto-tag propagation counts so the caller can surface a toast.
  Future<MergeResult> mergePerson(String sourceId, String intoId) async {
    final j = await _postJson("/api/v1/persons/$sourceId/merge", {"into": intoId});
    return MergeResult.fromJson(j);
  }

  /// Likely-duplicate persons for the merge picker, ranked by embedding
  /// similarity (closest first). Empty list if no candidates within the
  /// API's noise threshold. Mirrors `/api/v1/faces/:id/suggestions`.
  Future<List<MergeCandidate>> mergeCandidates(String personId) async {
    final j = await _getJson("/api/v1/persons/$personId/merge-candidates");
    final raw = (j["candidates"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(MergeCandidate.fromJson).toList();
  }

  /// Assets shared into the active workspace from other workspaces.
  /// Full list; the endpoint doesn't paginate.
  Future<List<SharedAsset>> sharedWithMe() async {
    final j = await _getJson("/api/v1/workspace/shared-with-me");
    final raw = (j["assets"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(SharedAsset.fromJson).toList();
  }

  /// Person groups (Family, Friends, Colleagues, …). Built-ins + workspace custom.
  Future<List<PersonGroup>> listPersonGroups() async {
    final j = await _getJson("/api/v1/person-groups");
    final raw = (j["groups"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(PersonGroup.fromJson).toList();
  }

  /// Replace all group memberships for [personId] with [groupIds].
  Future<void> setPersonGroups(String personId, List<String> groupIds) async {
    await _putJson("/api/v1/persons/$personId/groups", {"groupIds": groupIds});
  }

  /// Phase 5 (media import) — the caller's primary workspace id. The mobile
  /// client doesn't persist a workspace, so the Amazon ZIP upload (which takes
  /// `?workspaceId=`) resolves it on demand. GET /api/v1/workspace returns
  /// `{ workspace: { id, name, slug }, ... }`.
  Future<String> workspaceId() async {
    final j = await _getJson("/api/v1/workspace");
    final ws = j["workspace"] as Map<String, dynamic>?;
    final id = ws?["id"] as String?;
    if (id == null) {
      throw ApiException(404, "No workspace");
    }
    return id;
  }

  /// Phase 5 (media import) — third-party integrations + their connect state
  /// (provider/status only). Mirrors GET /api/v1/integrations.
  Future<List<Integration>> getIntegrations() async {
    final j = await _getJson("/api/v1/integrations");
    final raw =
        (j["integrations"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(Integration.fromJson).toList();
  }

  /// Phase 5 (media import) — recent import jobs, newest first. Mirrors
  /// GET /api/v1/imports; the imports screen polls this for progress.
  Future<List<ImportJob>> listImports() async {
    final j = await _getJson("/api/v1/imports");
    final raw =
        (j["imports"] as List? ?? const []).cast<Map<String, dynamic>>();
    return raw.map(ImportJob.fromJson).toList();
  }

  /// Phase 5 (media import) — a single import job. Mirrors GET /api/v1/imports/:id.
  Future<ImportJob> getImport(String id) async {
    final j = await _getJson("/api/v1/imports/$id");
    return ImportJob.fromJson(j);
  }

  /// Phase 5 (media import) — exchange a google_sign_in `serverAuthCode` for a
  /// stored, encrypted refresh token on the server (POST
  /// /api/v1/integrations/google/mobile-connect). The mobile bridge for the
  /// web's browser-redirect Google connect.
  Future<Integration> connectGoogle(String serverAuthCode) async {
    final j = await _postJson(
      "/api/v1/integrations/google/mobile-connect",
      {"serverAuthCode": serverAuthCode},
    );
    return Integration.fromJson(j);
  }

  /// Phase 5 (media import) — kick a server-side Google Takeout import of the
  /// Drive archive [driveFileId]. Returns the new import job id.
  /// POST /api/v1/imports/google → { importJobId }.
  Future<String> startGoogleTakeoutImport(String driveFileId) async {
    final j = await _postJson(
      "/api/v1/imports/google",
      {"driveFileId": driveFileId},
    );
    return j["importJobId"] as String;
  }

  /// Phase 5 (media import) — upload an Amazon Photos export [zip] as the RAW
  /// request body (Content-Type: application/zip, NOT multipart) to the
  /// streaming endpoint POST /api/v1/imports/upload?workspaceId=…, which pipes
  /// it to a temp file and enqueues an EXIF-only import. Returns the import job
  /// id.
  ///
  /// The file is streamed off disk via a StreamedRequest so peak RAM is bounded
  /// by one chunk regardless of archive size — the http package would otherwise
  /// buffer the whole body in memory.
  Future<String> uploadAmazonZip(
    File zip,
    String workspaceId, {
    String? provider,
  }) async {
    final len = await zip.length();
    final query = {"workspaceId": workspaceId};
    if (provider != null) query["provider"] = provider;
    final req = http.StreamedRequest(
      "POST",
      _uri("/api/v1/imports/upload", query),
    )
      ..headers.addAll(_headers)
      ..headers["Content-Type"] = "application/zip"
      ..contentLength = len;
    final pump = zip.openRead().listen(
          req.sink.add,
          onDone: req.sink.close,
          onError: req.sink.addError,
          cancelOnError: true,
        );
    final http.StreamedResponse streamed;
    try {
      streamed = await _http.send(req);
    } finally {
      await pump.cancel();
    }
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractError(res.body));
    }
    final j = json.decode(res.body) as Map<String, dynamic>;
    return j["importJobId"] as String;
  }

  void close() => _http.close();
}
