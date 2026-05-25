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
  });

  final String id;
  final String filename;
  final String mimeType;
  final int sizeBytes;
  final String? description;
  final String? classification;
  final DateTime? capturedAt;
  final String? directoryPath;

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
      );
}

class WorkspaceStats {
  WorkspaceStats({
    required this.total,
    required this.images,
    required this.documents,
    required this.videos,
    required this.favorites,
  });

  final int total;
  final int images;
  final int documents;
  final int videos;
  final int favorites;

  static WorkspaceStats fromJson(Map<String, dynamic> j) => WorkspaceStats(
        total: (j["total"] as num).toInt(),
        images: (j["images"] as num).toInt(),
        documents: (j["documents"] as num).toInt(),
        videos: (j["videos"] as num).toInt(),
        favorites: (j["favorites"] as num).toInt(),
      );
}
