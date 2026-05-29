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
    this.description,
    this.classification,
    this.capturedAt,
    this.directoryPath,
    this.isFavorite,
    this.rating,
    this.ocrText,
    this.processingState,
  });

  final String id;
  final String filename;
  final String mimeType;
  final int sizeBytes;
  final String? description;
  final String? classification;
  final DateTime? capturedAt;
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
        directoryPath: j["directoryPath"] as String?,
        isFavorite: j["isFavorite"] as bool?,
        rating: (j["rating"] as num?)?.toInt(),
        ocrText: j["ocrText"] as String?,
        processingState: j["processingState"] as String?,
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

class AssetCursor {
  AssetCursor({required this.createdBefore, required this.idBefore});
  final String createdBefore;
  final String idBefore;

  static AssetCursor fromJson(Map<String, dynamic> j) => AssetCursor(
        createdBefore: j["createdBefore"] as String,
        idBefore: j["idBefore"] as String,
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
        name: j["name"] as String,
        primaryAssetId: j["primaryAssetId"] as String,
        primaryFilename: j["primaryFilename"] as String,
        primaryMimeType: j["primaryMimeType"] as String,
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
    this.targetType,
    this.targetId,
  });

  final String id;
  final String? actorUserId;
  final String kind;
  final String? targetType;
  final String? targetId;
  final Map<String, dynamic> payload;
  final DateTime createdAt;

  static ActivityEvent fromJson(Map<String, dynamic> j) => ActivityEvent(
        id: j["id"] as String,
        actorUserId: j["actorUserId"] as String?,
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

/// A face cluster (Phase 5.1). `coverAssetId` is the asset the cover face
/// lives on — used to render an (uncropped, per C2) grid thumbnail.
/// `name` is null until the user labels the cluster.
class Person {
  Person({
    required this.id,
    required this.instanceCount,
    this.name,
    this.coverAssetId,
  });

  final String id;
  final int instanceCount;
  final String? name;
  final String? coverAssetId;

  static Person fromJson(Map<String, dynamic> j) => Person(
        id: j["id"] as String,
        instanceCount: (j["instanceCount"] as num?)?.toInt() ?? 0,
        name: j["name"] as String?,
        coverAssetId: j["coverAssetId"] as String?,
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
