// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Wire-format models. Mirrors the CLI's `Asset` shape (cli/src/api.ts)
// — we keep these structurally identical so future codegen from the
// OpenAPI doc (/api/v1/openapi.json) drops in without churn.

class Asset {
  Asset({
    required this.id,
    required this.filename,
    required this.mimeType,
    required this.sizeBytes,
    required this.createdAt,
    this.description,
    this.classification,
    this.capturedAt,
    this.directoryPath,
    this.isFavorite,
    this.rating,
    this.ocrText,
    this.processingState,
    this.widthPx,
    this.heightPx,
  });

  final String id;
  final String filename;
  final String mimeType;
  final int sizeBytes;
  final String? description;
  final String? classification;
  final DateTime? capturedAt;
  // Ingest time — always present (notNull server-side). The timeline groups
  // by capturedAt and falls back to this when EXIF capture time is missing,
  // mirroring the server's COALESCE(captured_at, created_at) sort.
  final DateTime createdAt;
  final String? directoryPath;
  final bool? isFavorite;
  final int? rating;
  // Phase 6.12 — extracted text layer (plain text / markdown / source file
  // contents). Only populated by the per-asset detail endpoint.
  final String? ocrText;
  // Pipeline state: captured → processing → classified → extracted → ready
  // (or failed). Anything other than ready/failed means work is still in
  // flight on the server.
  final String? processingState;
  // Native pixel dimensions. Present for processed images; null for videos,
  // PDFs, and assets still in the pipeline. Used by the face overlay to map
  // normalised bbox coordinates to screen positions.
  final int? widthPx;
  final int? heightPx;

  bool get isProcessing =>
      processingState != null &&
      processingState != "ready" &&
      processingState != "failed";

  static Asset fromJson(Map<String, dynamic> j) => Asset(
        id: j["id"] as String,
        filename: j["filename"] as String,
        mimeType: j["mimeType"] as String,
        sizeBytes: (j["sizeBytes"] as num).toInt(),
        description: j["description"] as String?,
        classification: j["classification"] as String?,
        capturedAt: j["capturedAt"] == null
            ? null
            : DateTime.parse(j["capturedAt"] as String),
        createdAt: DateTime.parse(j["createdAt"] as String),
        directoryPath: j["directoryPath"] as String?,
        isFavorite: j["isFavorite"] as bool?,
        rating: (j["rating"] as num?)?.toInt(),
        ocrText: j["ocrText"] as String?,
        processingState: j["processingState"] as String?,
        widthPx: (j["widthPx"] as num?)?.toInt(),
        heightPx: (j["heightPx"] as num?)?.toInt(),
      );
}

/// A label/tag with its active-asset count and a sample asset for a
/// thumbnail — backs the Explore → Things grid.
class TopTag {
  TopTag({
    required this.id,
    required this.name,
    required this.color,
    required this.count,
    this.sampleAssetId,
  });

  final String id;
  final String name;
  final String color;
  final int count;
  final String? sampleAssetId;

  static TopTag fromJson(Map<String, dynamic> j) => TopTag(
        id: j["id"] as String,
        name: j["name"] as String,
        color: (j["color"] as String?) ?? "#6366f1",
        count: (j["count"] as num?)?.toInt() ?? 0,
        sampleAssetId: j["sampleAssetId"] as String?,
      );
}

/// Keyset cursor for the asset list. Field is sort-axis agnostic — the
/// backend returns `capturedBefore` when we ask for `sort=captured`, which
/// is what the mobile grid now does so photos and documents are ordered by
/// their EXIF capture time (i.e. the meta-data date), not by ingest time.
class AssetCursor {
  AssetCursor({required this.before, required this.idBefore});
  final String before;
  final String idBefore;

  static AssetCursor fromJson(Map<String, dynamic> j) => AssetCursor(
        // Backend serialises the keyset under whichever axis the request
        // used; accept either so a legacy nextCursor response still parses.
        before: (j["capturedBefore"] ?? j["createdBefore"]) as String,
        idBefore: j["idBefore"] as String,
      );
}

/// One row of `/api/v1/assets/buckets` — count of assets in a given month,
/// keyed by COALESCE(captured_at, created_at). Newest first.
class AssetBucket {
  AssetBucket({required this.month, required this.count});
  final String month; // "YYYY-MM"
  final int count;

  static AssetBucket fromJson(Map<String, dynamic> j) => AssetBucket(
        month: j["month"] as String,
        count: (j["count"] as num).toInt(),
      );
}

class AssetPage {
  AssetPage({required this.assets, required this.nextCursor});
  final List<Asset> assets;
  final AssetCursor? nextCursor;
  bool get hasMore => nextCursor != null;
}

/// Server-side row: one path with its own asset count (descendants not
/// included). The tree is built client-side by splitting on `/`.
class FolderLeaf {
  FolderLeaf({required this.path, required this.assetCount});
  final String path;
  final int assetCount;

  static FolderLeaf fromJson(Map<String, dynamic> j) => FolderLeaf(
        path: j["path"] as String,
        assetCount: (j["assetCount"] as num).toInt(),
      );
}

class FolderTree {
  FolderTree({required this.paths, required this.rootAssetCount});
  final List<FolderLeaf> paths;
  final int rootAssetCount;
}

/// Manual album. `description` is optional free text.
class Collection {
  Collection({
    required this.id,
    required this.name,
    this.description,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String name;
  final String? description;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  static Collection fromJson(Map<String, dynamic> j) => Collection(
        id: j["id"] as String,
        name: j["name"] as String,
        description: j["description"] as String?,
        createdAt: j["createdAt"] == null
            ? null
            : DateTime.parse(j["createdAt"] as String),
        updatedAt: j["updatedAt"] == null
            ? null
            : DateTime.parse(j["updatedAt"] as String),
      );
}

/// Saved-search collection. `query` is the serialised filter expression.
class SmartCollection {
  SmartCollection({
    required this.id,
    required this.name,
    this.query,
    this.createdAt,
  });

  final String id;
  final String name;
  final String? query;
  final DateTime? createdAt;

  static SmartCollection fromJson(Map<String, dynamic> j) => SmartCollection(
        id: j["id"] as String,
        name: j["name"] as String,
        query: j["query"] as String?,
        createdAt: j["createdAt"] == null
            ? null
            : DateTime.parse(j["createdAt"] as String),
      );
}

/// Project grouping. `color` is an optional hex/label string for chrome.
class Project {
  Project({
    required this.id,
    required this.name,
    this.description,
    this.color,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String name;
  final String? description;
  final String? color;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  static Project fromJson(Map<String, dynamic> j) => Project(
        id: j["id"] as String,
        name: j["name"] as String,
        description: j["description"] as String?,
        color: j["color"] as String?,
        createdAt: j["createdAt"] == null
            ? null
            : DateTime.parse(j["createdAt"] as String),
        updatedAt: j["updatedAt"] == null
            ? null
            : DateTime.parse(j["updatedAt"] as String),
      );
}

/// AssetStack — a group of near-duplicate assets fronted by one primary.
/// Carries the primary's denormalised fields for thumbnail rendering.
/// (Named AssetStack, not Stack, to avoid colliding with Flutter's
/// material Stack widget in screens that import both.)
class AssetStack {
  AssetStack({
    required this.id,
    required this.name,
    required this.primaryAssetId,
    required this.primaryFilename,
    required this.primaryMimeType,
    required this.memberCount,
    this.primaryCapturedAt,
    this.createdAt,
  });

  final String id;
  final String name;
  final String primaryAssetId;
  final String primaryFilename;
  final String primaryMimeType;
  final int memberCount;
  final DateTime? primaryCapturedAt;
  final DateTime? createdAt;

  static AssetStack fromJson(Map<String, dynamic> j) => AssetStack(
        id: j["id"] as String,
        // Auto-detected (burst/duplicate) stacks have no name, and a primary
        // with missing metadata can leave these null — cast defensively so the
        // Stacks page doesn't crash with a Null→String type error.
        name: (j["name"] as String?) ?? "Untitled stack",
        primaryAssetId: (j["primaryAssetId"] as String?) ?? "",
        primaryFilename: (j["primaryFilename"] as String?) ?? "",
        primaryMimeType: (j["primaryMimeType"] as String?) ?? "",
        memberCount: (j["memberCount"] as num?)?.toInt() ?? 0,
        primaryCapturedAt: j["primaryCapturedAt"] == null
            ? null
            : DateTime.parse(j["primaryCapturedAt"] as String),
        createdAt: j["createdAt"] == null
            ? null
            : DateTime.parse(j["createdAt"] as String),
      );
}

/// One workspace activity-feed row (Phase 7a). `payload` is free-form
/// JSON whose keys vary by `kind`; the Updates screen reads `assetId` /
/// `excerpt` out of it defensively. `actorUserId` is null for
/// system-generated events.
class ActivityEvent {
  ActivityEvent({
    required this.id,
    required this.kind,
    required this.payload,
    required this.createdAt,
    this.actorUserId,
    this.actorUserName,
    this.actorUserEmail,
    this.targetType,
    this.targetId,
  });

  final String id;
  final String? actorUserId;
  final String? actorUserName;
  final String? actorUserEmail;
  final String kind;
  final String? targetType;
  final String? targetId;
  final Map<String, dynamic> payload;
  final DateTime createdAt;

  static ActivityEvent fromJson(Map<String, dynamic> j) => ActivityEvent(
        id: j["id"] as String,
        actorUserId: j["actorUserId"] as String?,
        actorUserName: j["actorUserName"] as String?,
        actorUserEmail: j["actorUserEmail"] as String?,
        kind: j["kind"] as String? ?? "",
        targetType: j["targetType"] as String?,
        targetId: j["targetId"] as String?,
        payload: (j["payload"] as Map?)?.cast<String, dynamic>() ?? const {},
        createdAt: DateTime.parse(j["createdAt"] as String),
      );
}

class ActivityPage {
  ActivityPage({required this.events, required this.nextCursor});
  final List<ActivityEvent> events;
  final String? nextCursor;
  bool get hasMore => nextCursor != null;
}

/// An asset shared INTO the active workspace from another (Phase 7b,
/// reference model). Wraps a plain [Asset] plus the source-workspace name
/// for the "from <workspace>" badge.
class SharedAsset {
  SharedAsset({required this.asset, this.sourceWorkspaceName});
  final Asset asset;
  final String? sourceWorkspaceName;

  static SharedAsset fromJson(Map<String, dynamic> j) {
    final from = (j["sharedFrom"] as Map?)?.cast<String, dynamic>();
    return SharedAsset(
      asset: Asset.fromJson(j),
      sourceWorkspaceName: from?["workspaceName"] as String?,
    );
  }
}

/// Normalised face bounding box (all values 0..1 relative to image dimensions).
class PersonBbox {
  const PersonBbox({
    required this.x,
    required this.y,
    required this.w,
    required this.h,
  });

  final double x, y, w, h;

  double get cx => x + w / 2;
  double get cy => y + h / 2;

  static PersonBbox? fromJson(dynamic j) {
    if (j == null) return null;
    final m = j as Map<String, dynamic>;
    return PersonBbox(
      x: (m["x"] as num).toDouble(),
      y: (m["y"] as num).toDouble(),
      w: (m["w"] as num).toDouble(),
      h: (m["h"] as num).toDouble(),
    );
  }
}

/// A face cluster (Phase 5.1). `coverAssetId` is the asset the cover face
/// lives on. `coverBbox` is the normalised bbox of the cover face — used to
/// zoom into the face in the People grid circle.
/// `name` is null until the user labels the cluster.
class Person {
  Person({
    required this.id,
    required this.instanceCount,
    this.name,
    this.coverAssetId,
    this.coverBbox,
  });

  final String id;
  final int instanceCount;
  final String? name;
  final String? coverAssetId;
  final PersonBbox? coverBbox;

  static Person fromJson(Map<String, dynamic> j) => Person(
        id: j["id"] as String,
        instanceCount: (j["instanceCount"] as num?)?.toInt() ?? 0,
        name: j["name"] as String?,
        coverAssetId: j["coverAssetId"] as String?,
        coverBbox: PersonBbox.fromJson(j["coverBbox"]),
      );
}

class FaceSuggestion {
  const FaceSuggestion({required this.person, required this.distance});
  final Person person;
  final double distance;

  static FaceSuggestion fromJson(Map<String, dynamic> j) => FaceSuggestion(
        person: Person(
          id: j["id"] as String,
          instanceCount: (j["instanceCount"] as num?)?.toInt() ?? 0,
          name: j["name"] as String?,
        ),
        distance: (j["distance"] as num).toDouble(),
      );
}

/// One detected face on an asset. `bbox` is normalised (0..1). `personId` /
/// `personName` are null when the face hasn't been assigned to a cluster yet.
class AssetFace {
  const AssetFace({
    required this.id,
    required this.bbox,
    required this.confidence,
    this.personId,
    this.personName,
    this.hidden = false,
  });

  final String id;
  final PersonBbox bbox;
  final double confidence;
  final String? personId;
  final String? personName;
  final bool hidden;

  static AssetFace fromJson(Map<String, dynamic> j) => AssetFace(
        id: j["id"] as String,
        bbox: PersonBbox.fromJson(j["bbox"])!,
        confidence: (j["confidence"] as num).toDouble(),
        personId: j["personId"] as String?,
        personName: j["personName"] as String?,
        hidden: j["hidden"] as bool? ?? false,
      );
}

class WorkspaceStats {
  WorkspaceStats({
    required this.total,
    required this.images,
    required this.documents,
    required this.videos,
    required this.favorites,
    this.processing = 0,
  });

  final int total;
  final int images;
  final int documents;
  final int videos;
  final int favorites;
  // Count of active assets still being processed server-side (not ready/failed).
  final int processing;

  static WorkspaceStats fromJson(Map<String, dynamic> j) => WorkspaceStats(
        total: (j["total"] as num).toInt(),
        images: (j["images"] as num).toInt(),
        documents: (j["documents"] as num).toInt(),
        videos: (j["videos"] as num).toInt(),
        favorites: (j["favorites"] as num).toInt(),
        processing: (j["processing"] as num?)?.toInt() ?? 0,
      );
}

/// Response of GET /api/v1/assets/:id/hls. `state` is "ready" |
/// "transcoding" | "failed" | "idle". `playlistUrl` (a relative,
/// auth-gated proxy path) is present only when state == "ready".
class HlsManifest {
  HlsManifest({required this.state, this.playlistUrl});

  final String state;
  final String? playlistUrl;

  bool get isReady => state == "ready" && playlistUrl != null;
  bool get isTranscoding => state == "transcoding" || state == "idle";
  bool get isFailed => state == "failed";

  static HlsManifest fromJson(Map<String, dynamic> j) => HlsManifest(
        state: (j["state"] as String?) ?? "idle",
        playlistUrl: j["playlistUrl"] as String?,
      );
}
