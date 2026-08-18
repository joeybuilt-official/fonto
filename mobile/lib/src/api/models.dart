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
    this.kind,
    this.source,
    this.scope,
    this.motionPhoto = false,
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
  // Task 20 / Photos-Files split — KIND partition (moment|screenshot|graphics|
  // document|video) or null when unclassified (Inbox surface). Source-app the
  // asset was imported from (e.g. "web-upload", "drive").
  final String? kind;
  final String? source;
  // ADR 0008/0009 — partition the asset belongs to: PERSONAL (default) or
  // SHOOT. Drives default visibility: personal surfaces (timeline, memories)
  // hide SHOOT unless the user opts in via the scope switcher.
  final String? scope;
  // M12 / ADR 0014 — motion (Live) photo: this still carries a playable clip
  // (embedded Android MP4 or a paired Apple MOV). Drives the "LIVE" badge +
  // long-press playback. The clip URL is fetched on demand via
  // /api/v1/assets/{id}/url?variant=motion (FontoClient.assetMotionUrl).
  final bool motionPhoto;

  bool get isProcessing =>
      processingState != null &&
      processingState != "ready" &&
      processingState != "failed";

  /// Local-only copy with a field changed — used for optimistic UI when an
  /// edit is queued offline (the server row arrives on the next sync).
  Asset copyWith({bool? isFavorite, int? rating}) => Asset(
        id: id,
        filename: filename,
        mimeType: mimeType,
        sizeBytes: sizeBytes,
        createdAt: createdAt,
        description: description,
        classification: classification,
        capturedAt: capturedAt,
        directoryPath: directoryPath,
        isFavorite: isFavorite ?? this.isFavorite,
        rating: rating ?? this.rating,
        ocrText: ocrText,
        processingState: processingState,
        widthPx: widthPx,
        heightPx: heightPx,
        kind: kind,
        source: source,
        scope: scope,
        motionPhoto: motionPhoto,
      );

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
        kind: j["kind"] as String?,
        source: j["source"] as String?,
        scope: j["scope"] as String?,
        motionPhoto: (j["motionPhoto"] as bool?) ?? false,
      );

  /// Null-safe list parse. Returns null — instead of throwing and aborting the
  /// entire page — when a single row is missing a required field or carries a
  /// malformed date. List decoders use `.map(Asset.tryParse).whereType<Asset>()`
  /// so one bad row drops out rather than blanking the whole grid.
  static Asset? tryParse(Object? j) {
    if (j is! Map<String, dynamic>) return null;
    try {
      return fromJson(j);
    } catch (_) {
      return null;
    }
  }
}

/// A candidate near-duplicate group (ADR 0010 / variant_groups). `members` are
/// the active assets the detector grouped; `confidence` is the tightest
/// pairwise similarity (0..1) or null.
class DupGroup {
  DupGroup({required this.groupId, required this.members, this.confidence});

  final String groupId;
  final List<Asset> members;
  final double? confidence;

  static DupGroup fromJson(Map<String, dynamic> j) => DupGroup(
        groupId: j["groupId"] as String,
        confidence: (j["confidence"] as num?)?.toDouble(),
        members: (j["members"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(Asset.tryParse)
            .whereType<Asset>()
            .toList(),
      );
}

/// A deliberate photography session (ADR 0008). `clientId` null = hobby shoot.
/// `total` is the asset count across all stages, for the browse list.
class Shoot {
  Shoot({
    required this.id,
    required this.name,
    this.shootDate,
    this.clientId,
    this.kind,
    this.total = 0,
  });

  final String id;
  final String name;
  final String? shootDate;
  final String? clientId;
  final String? kind;
  final int total;

  static Shoot fromJson(Map<String, dynamic> j) {
    final counts = j["counts"] as Map<String, dynamic>?;
    return Shoot(
      id: j["id"] as String,
      name: j["name"] as String,
      shootDate: j["shootDate"] as String?,
      clientId: j["clientId"] as String?,
      kind: j["kind"] as String?,
      total: (counts?["total"] as num?)?.toInt() ?? 0,
    );
  }
}

/// One prior-year bucket of "On this day" memories. `count` is the pre-cap
/// total for the year; `assets` is capped server-side (MEMORIES_MAX_PER_YEAR).
class MemoryYear {
  MemoryYear({required this.year, required this.count, required this.assets});

  final int year;
  final int count;
  final List<Asset> assets;

  static MemoryYear fromJson(Map<String, dynamic> j) => MemoryYear(
        year: (j["year"] as num).toInt(),
        count: (j["count"] as num).toInt(),
        assets: (j["assets"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(Asset.tryParse)
            .whereType<Asset>()
            .toList(),
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

/// M10 / ADR 0013 — a tag in the hierarchy. `parentId` is the tree edge (null =
/// root); `path` is the materialized ancestor-id path incl self, used for
/// descendant-inclusive filtering server-side. Depth = number of ids in path.
class TagNode {
  TagNode({
    required this.id,
    required this.name,
    required this.color,
    this.parentId,
    this.path = "",
  });

  final String id;
  final String name;
  final String color;
  final String? parentId;
  final String path;

  int get depth => path.split("/").where((s) => s.isNotEmpty).length;

  static TagNode fromJson(Map<String, dynamic> j) => TagNode(
        id: j["id"] as String,
        name: j["name"] as String,
        color: (j["color"] as String?) ?? "#6366f1",
        parentId: j["parentId"] as String?,
        path: (j["path"] as String?) ?? "",
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
    if (j is! Map<String, dynamic>) return null;
    // A partial bbox (one key missing, e.g. {"x":0.1}) must return null — not
    // throw — so AssetFace.fromJson's null-drop guard can discard the unusable
    // face rather than the whole assetFaces parse crashing.
    final x = j["x"] as num?;
    final y = j["y"] as num?;
    final w = j["w"] as num?;
    final h = j["h"] as num?;
    if (x == null || y == null || w == null || h == null) return null;
    return PersonBbox(
      x: x.toDouble(),
      y: y.toDouble(),
      w: w.toDouble(),
      h: h.toDouble(),
    );
  }
}

/// A face cluster (Phase 5.1). `coverAssetId` is the asset the cover face
/// lives on. `coverBbox` is the normalised bbox of the cover face — used to
/// zoom into the face in the People grid circle.
/// `name` is null until the user labels the cluster.
class PersonGroup {
  const PersonGroup({
    required this.id,
    required this.name,
    required this.color,
    required this.builtin,
  });

  final String id;
  final String name;
  final String color;
  final bool builtin;

  static PersonGroup fromJson(Map<String, dynamic> j) => PersonGroup(
        id: j["id"] as String,
        name: j["name"] as String,
        color: (j["color"] as String?) ?? "#6b7280",
        builtin: (j["builtin"] as bool?) ?? false,
      );
}

class Person {
  Person({
    required this.id,
    required this.instanceCount,
    this.name,
    this.coverAssetId,
    this.coverBbox,
    this.coverFaceCropUrl,
    this.groupIds = const [],
    this.hidden = false,
  });

  final String id;
  final int instanceCount;
  final String? name;
  final String? coverAssetId;
  final PersonBbox? coverBbox;
  final String? coverFaceCropUrl;
  final List<String> groupIds;
  // `true` when the cluster has been ignored (hidden from People). Mirrors the
  // web `hidden` flag; restore via PATCH /persons/:id { hidden:false }.
  final bool hidden;

  static Person fromJson(Map<String, dynamic> j) => Person(
        id: j["id"] as String,
        instanceCount: (j["instanceCount"] as num?)?.toInt() ?? 0,
        name: j["name"] as String?,
        coverAssetId: j["coverAssetId"] as String?,
        coverBbox: PersonBbox.fromJson(j["coverBbox"]),
        coverFaceCropUrl: j["coverFaceCropUrl"] as String?,
        groupIds: (j["groupIds"] as List? ?? const []).cast<String>(),
        hidden: j["hidden"] as bool? ?? false,
      );
}

/// Result of a person merge. `assigned` is how many faces the server
/// auto-tagged onto the (named) target by propagation; `suggested` is how
/// many it surfaced as suggestions. Both are 0 when the target is unnamed
/// (server returns `propagated: null`). Mirrors the web post-merge toast.
class MergeResult {
  const MergeResult({this.assigned = 0, this.suggested = 0});
  final int assigned;
  final int suggested;

  static MergeResult fromJson(Map<String, dynamic> j) {
    final p = j["propagated"];
    if (p is! Map<String, dynamic>) return const MergeResult();
    return MergeResult(
      assigned: (p["assigned"] as num?)?.toInt() ?? 0,
      suggested: (p["suggested"] as num?)?.toInt() ?? 0,
    );
  }
}

/// Payload for the Ignored review screen — the three things a user can ignore,
/// each restorable. Mirrors GET /api/v1/faces/ignored.
class IgnoredData {
  const IgnoredData({
    this.persons = const [],
    this.photos = const [],
    this.faces = const [],
  });
  final List<Person> persons;
  final List<IgnoredPhoto> photos;
  final List<IgnoredFace> faces;

  bool get isEmpty => persons.isEmpty && photos.isEmpty && faces.isEmpty;

  static IgnoredData fromJson(Map<String, dynamic> j) => IgnoredData(
        persons: (j["persons"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(Person.fromJson)
            .toList(),
        photos: (j["photos"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(IgnoredPhoto.fromJson)
            .toList(),
        faces: (j["faces"] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(IgnoredFace.fromJson)
            .toList(),
      );
}

/// A photo whose faces are all ignored. Restore via
/// PATCH /assets/:id/faces-ignored { ignored:false }.
class IgnoredPhoto {
  const IgnoredPhoto({required this.id, this.filename});
  final String id;
  final String? filename;

  static IgnoredPhoto fromJson(Map<String, dynamic> j) => IgnoredPhoto(
        id: j["id"] as String,
        filename: j["filename"] as String?,
      );
}

/// An individually-hidden face. Restore via PATCH /faces/:id { hidden:false }.
class IgnoredFace {
  const IgnoredFace({required this.id, required this.assetId, this.faceCropUrl});
  final String id;
  final String assetId;
  final String? faceCropUrl;

  static IgnoredFace fromJson(Map<String, dynamic> j) => IgnoredFace(
        id: j["id"] as String,
        assetId: j["assetId"] as String,
        faceCropUrl: j["faceCropUrl"] as String?,
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

/// A likely-duplicate person surfaced by the Merge picker. Distance is
/// cosine distance between embeddings; smaller = more likely the same
/// person. Tier labels in the UI mirror the face-suggestion bands.
class MergeCandidate {
  const MergeCandidate({required this.person, required this.distance});
  final Person person;
  final double distance;

  static MergeCandidate fromJson(Map<String, dynamic> j) => MergeCandidate(
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

  /// Returns null when the server sends a face without a usable bbox; the
  /// `assetFaces` parser drops those so the overlay never receives a null.
  static AssetFace? fromJson(Map<String, dynamic> j) {
    final bbox = PersonBbox.fromJson(j["bbox"]);
    if (bbox == null) return null;
    return AssetFace(
      id: j["id"] as String,
      bbox: bbox,
      confidence: (j["confidence"] as num).toDouble(),
      personId: j["personId"] as String?,
      personName: j["personName"] as String?,
      hidden: j["hidden"] as bool? ?? false,
    );
  }
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

  // Null-safe: stats() doubles as the login "is this PAT valid?" probe, so a
  // server that omits any field (older build, feature flagged off) must yield a
  // WorkspaceStats, not an uncatchable TypeError on the login screen.
  static WorkspaceStats fromJson(Map<String, dynamic> j) => WorkspaceStats(
        total: (j["total"] as num?)?.toInt() ?? 0,
        images: (j["images"] as num?)?.toInt() ?? 0,
        documents: (j["documents"] as num?)?.toInt() ?? 0,
        videos: (j["videos"] as num?)?.toInt() ?? 0,
        favorites: (j["favorites"] as num?)?.toInt() ?? 0,
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

/// Counts behind the Collections screen's utility tiles
/// (Favorites / Trash / Screenshots / Archive / Documents). Backed by
/// indexed COUNT queries on /api/v1/collections/stats.
class CollectionsStats {
  const CollectionsStats({
    required this.favorites,
    required this.trash,
    required this.screenshots,
    required this.archived,
    required this.documents,
  });

  final int favorites;
  final int trash;
  final int screenshots;
  final int archived;
  final int documents;

  static CollectionsStats fromJson(Map<String, dynamic> j) => CollectionsStats(
        favorites: (j["favorites"] as num?)?.toInt() ?? 0,
        trash: (j["trash"] as num?)?.toInt() ?? 0,
        screenshots: (j["screenshots"] as num?)?.toInt() ?? 0,
        archived: (j["archived"] as num?)?.toInt() ?? 0,
        documents: (j["documents"] as num?)?.toInt() ?? 0,
      );
}

/// One reverse-geocoded place group on the Collections screen. `previewIds`
/// are up to 4 asset IDs the UI resolves through `/api/v1/assets/urls` for
/// the 2×2 thumbnail mosaic.
class PlaceGroup {
  const PlaceGroup({
    required this.placeName,
    required this.count,
    required this.previewIds,
  });

  final String placeName;
  final int count;
  final List<String> previewIds;

  static PlaceGroup fromJson(Map<String, dynamic> j) => PlaceGroup(
        placeName: j["placeName"] as String,
        count: (j["count"] as num?)?.toInt() ?? 0,
        previewIds: (j["previewIds"] as List? ?? const []).cast<String>(),
      );
}

/// A place cluster WITH centroid coordinates, for the Places map + pins.
/// `lat`/`lng` are the mean of the place's geo-tagged assets and may be null.
/// Mirrors GET /api/v1/assets/places.
class GeoPlace {
  const GeoPlace({
    required this.name,
    required this.count,
    this.coverAssetId,
    this.lat,
    this.lng,
  });

  final String name;
  final int count;
  final String? coverAssetId;
  final double? lat;
  final double? lng;

  bool get hasCoords => lat != null && lng != null;

  static GeoPlace fromJson(Map<String, dynamic> j) => GeoPlace(
        name: j["name"] as String,
        count: (j["count"] as num?)?.toInt() ?? 0,
        coverAssetId: j["coverAssetId"] as String?,
        lat: (j["lat"] as num?)?.toDouble(),
        lng: (j["lng"] as num?)?.toDouble(),
      );
}

/// Phase 5 (media import) — one `import_jobs` row, mirrors the web /app/imports
/// list shape (GET /api/v1/imports). Drives the imports screen's progress list.
class ImportJob {
  const ImportJob({
    required this.id,
    required this.provider,
    required this.status,
    required this.itemsTotal,
    required this.itemsProcessed,
    required this.itemsDeduped,
    required this.itemsFailed,
    this.error,
  });

  final String id;

  /// "google-takeout" | "amazon-photos".
  final String provider;

  /// "pending" | "running" | "completed" | "failed".
  final String status;
  final int itemsTotal;
  final int itemsProcessed;
  final int itemsDeduped;
  final int itemsFailed;
  final String? error;

  bool get isTerminal => status == "completed" || status == "failed";

  /// 0.0–1.0 progress fraction, or null when the total isn't known yet.
  double? get fraction =>
      itemsTotal > 0 ? (itemsProcessed / itemsTotal).clamp(0.0, 1.0) : null;

  String get providerLabel {
    switch (provider) {
      case "google-takeout":
        return "Google Takeout";
      case "amazon-photos":
        return "Amazon Photos";
      default:
        return provider;
    }
  }

  static ImportJob fromJson(Map<String, dynamic> j) => ImportJob(
        id: j["id"] as String,
        provider: (j["provider"] as String?) ?? "",
        status: (j["status"] as String?) ?? "pending",
        itemsTotal: (j["itemsTotal"] as num?)?.toInt() ?? 0,
        itemsProcessed: (j["itemsProcessed"] as num?)?.toInt() ?? 0,
        itemsDeduped: (j["itemsDeduped"] as num?)?.toInt() ?? 0,
        itemsFailed: (j["itemsFailed"] as num?)?.toInt() ?? 0,
        error: j["error"] as String?,
      );
}

/// Phase 5 (media import) — a third-party integration's connect state, mirrors
/// GET /api/v1/integrations. Only `provider` + `status` are returned (never the
/// encrypted token).
class Integration {
  const Integration({required this.provider, required this.status});

  /// e.g. "google".
  final String provider;

  /// "active" | "needs_reconnect" | "revoked".
  final String status;

  bool get isActive => status == "active";

  static Integration fromJson(Map<String, dynamic> j) => Integration(
        provider: (j["provider"] as String?) ?? "",
        status: (j["status"] as String?) ?? "revoked",
      );
}

/// Phase B6 (storage placement) — the `storage` block from GET /api/v1/workspace.
/// `policy` is the effective workspace policy; `mirror` figures describe how much
/// of the eligible library has a verified local (NAS) copy. `localBytes` is the
/// separate NAS-disk figure (C3), distinct from the R2 quota usage.
class StoragePlacement {
  const StoragePlacement({
    required this.policy,
    required this.usageBytes,
    required this.quotaBytes,
    required this.assetCount,
    required this.eligible,
    required this.mirrored,
    required this.localBytes,
  });

  final String policy;
  final int usageBytes;
  final int? quotaBytes;
  final int assetCount;
  final int eligible;
  final int mirrored;
  final int localBytes;

  bool get isMirror => policy == "mirror";

  static StoragePlacement fromJson(Map<String, dynamic> j) {
    final mirror = (j["mirror"] as Map<String, dynamic>?) ?? const {};
    return StoragePlacement(
      policy: (j["policy"] as String?) ?? "r2_only",
      usageBytes: (j["usageBytes"] as num?)?.toInt() ?? 0,
      quotaBytes: (j["quotaBytes"] as num?)?.toInt(),
      assetCount: (j["assetCount"] as num?)?.toInt() ?? 0,
      eligible: (mirror["eligible"] as num?)?.toInt() ?? 0,
      mirrored: (mirror["mirrored"] as num?)?.toInt() ?? 0,
      localBytes: (mirror["localBytes"] as num?)?.toInt() ?? 0,
    );
  }
}

// M15.3 — reason-bucketed date review (Tidy Up). Mirrors the web bucket
// contract from GET /api/admin/review-queue/buckets.
class ReviewBucketSample {
  ReviewBucketSample({
    required this.assetId,
    required this.filename,
    this.capturedAt,
    this.mapEstimate,
    this.mapPrecision,
  });

  final String assetId;
  final String filename;
  final String? capturedAt;
  final String? mapEstimate;
  final String? mapPrecision;

  static ReviewBucketSample fromJson(Map<String, dynamic> j) => ReviewBucketSample(
        assetId: j["assetId"] as String,
        filename: (j["filename"] as String?) ?? "",
        capturedAt: j["capturedAt"] as String?,
        mapEstimate: j["mapEstimate"] as String?,
        mapPrecision: j["mapPrecision"] as String?,
      );
}

class ReviewBucket {
  ReviewBucket({
    required this.bucketKey,
    required this.axis,
    required this.evidenceSource,
    required this.conflict,
    required this.reasonLabel,
    required this.count,
    required this.confidenceTier,
    required this.sample,
  });

  // ADR 0059 — opaque, server-issued key; passed back verbatim on apply/undo.
  final String bucketKey;
  final String axis; // source | folder | time
  final String? evidenceSource;
  final bool conflict;
  final String reasonLabel; // server-formatted (folder path / time span / reason)
  final int count;
  final String confidenceTier; // high | medium | low
  final List<ReviewBucketSample> sample;

  static ReviewBucket fromJson(Map<String, dynamic> j) => ReviewBucket(
        bucketKey: (j["bucketKey"] as String?) ?? "",
        axis: (j["axis"] as String?) ?? "source",
        evidenceSource: j["evidenceSource"] as String?,
        conflict: (j["conflict"] as bool?) ?? false,
        reasonLabel: (j["reasonLabel"] as String?) ?? "",
        count: (j["count"] as num?)?.toInt() ?? 0,
        confidenceTier: (j["confidenceTier"] as String?) ?? "low",
        sample: ((j["sample"] as List<dynamic>?) ?? const [])
            .map((e) => ReviewBucketSample.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class ReviewBuckets {
  ReviewBuckets({
    required this.buckets,
    required this.totalReview,
    this.progressSorted,
    this.progressTotal,
  });

  final List<ReviewBucket> buckets;
  final int totalReview;
  final int? progressSorted;
  final int? progressTotal;

  static ReviewBuckets fromJson(Map<String, dynamic> j) {
    final prog = j["progress"] as Map<String, dynamic>?;
    return ReviewBuckets(
      buckets: ((j["buckets"] as List<dynamic>?) ?? const [])
          .map((e) => ReviewBucket.fromJson(e as Map<String, dynamic>))
          .toList(),
      totalReview: (j["totalReview"] as num?)?.toInt() ?? 0,
      progressSorted: (prog?["sorted"] as num?)?.toInt(),
      progressTotal: (prog?["total"] as num?)?.toInt(),
    );
  }
}
