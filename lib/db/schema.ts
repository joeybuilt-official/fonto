// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import {
  pgSchema,
  uuid,
  text,
  bigint,
  timestamp,
  index,
  boolean,
  jsonb,
  uniqueIndex,
  integer,
  doublePrecision,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const fontoSchema = pgSchema("fonto");

export const workspaces = fontoSchema.table(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("personal"),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("workspaces_user_id_idx").on(table.userId)]
);

export const assets = fontoSchema.table(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    syncState: text("sync_state").notNull().default("synced"),
    processingState: text("processing_state").notNull().default("captured"),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    source: text("source"),
    classification: text("classification"),
    description: text("description"),
    extractedText: text("extracted_text"),
    correspondentId: uuid("correspondent_id"),
    documentTypeId: uuid("document_type_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    // 64-bit perceptual hash (sign-of-DCT-coefficients). NULL until computed.
    // Stored as bigint mode 'bigint' to preserve the high bit.
    phash: bigint("phash", { mode: "bigint" }),
    // Dominant color palette: [{ hex: "#rrggbb", weight: 0.0..1.0 }, ...]
    // (sorted by weight desc, up to 8 entries). NULL until computed.
    colors: jsonb("colors"),
    // OCR-extracted text for image assets. NULL until OCR succeeds.
    ocrText: text("ocr_text"),
    // OCR pipeline state: pending | ready | failed | skipped (non-image).
    ocrState: text("ocr_state").notNull().default("pending"),
    // Full raw EXIF/IPTC/XMP metadata blob extracted at ingest. NULL for
    // non-image assets or when extraction fails. See lib/exif.ts.
    exif: jsonb("exif"),
    // GPS coordinates lifted out of EXIF for indexable map queries.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    // Camera identity. Free-text — vendor strings vary wildly.
    cameraMake: text("camera_make"),
    cameraModel: text("camera_model"),
    lensModel: text("lens_model"),
    // Capture parameters.
    focalLength: real("focal_length"),
    fNumber: real("f_number"),
    iso: integer("iso"),
    exposureTime: text("exposure_time"),
    // EXIF orientation tag (1..8); used by clients to rotate display.
    orientation: integer("orientation"),
    // Native pixel dimensions of the captured image.
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    // Last error message from the BullMQ asset-processing pipeline, if any.
    // Cleared on a successful run. Surfaced in /admin/jobs.
    processingError: text("processing_error"),
    // Number of times the BullMQ worker has attempted to process this asset.
    // Incremented each time the worker picks the job up; reset on success.
    processingAttempts: integer("processing_attempts").notNull().default(0),
    // Phase 1.1 — multi-resolution derivatives. Populated by the thumbnails
    // worker; NULL until generated (or for non-image assets). Keys are R2
    // object keys, not full URLs; see `assetDerivativeKey()` in lib/r2.ts.
    // `thumbnailKey` is the 256px WebP grid thumbnail; `previewKey` is the
    // 1080px WebP lightbox preview. `thumbnailGeneratedAt` is set on the
    // last successful generation pass (same value applies to both).
    thumbnailKey: text("thumbnail_key"),
    previewKey: text("preview_key"),
    thumbnailGeneratedAt: timestamp("thumbnail_generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Phase 2.3 — monotonic per-workspace delta-sync cursor. Allocated via
    // `lib/db/seq.ts:nextSeq()` on every insert/update that mutates a field
    // the sync stream exposes. NULL only on rows older than the 0009 backfill
    // (the backfill stamps everything; new rows must always set this).
    seq: bigint("seq", { mode: "bigint" }),
  },
  (table) => [
    index("assets_workspace_id_idx").on(table.workspaceId),
    index("assets_mime_type_idx").on(table.mimeType),
    index("assets_lifecycle_state_idx").on(table.lifecycleState),
    index("assets_processing_state_idx").on(table.processingState),
    index("assets_ocr_state_idx").on(table.ocrState),
    index("assets_phash_idx").on(table.phash),
    // Timeline browsing: workspace assets ordered by capture date.
    index("assets_workspace_captured_at_idx").on(
      table.workspaceId,
      sql`${table.capturedAt} desc`
    ),
    // Map queries: (lat, lon) btree for future bounding-box scans.
    index("assets_lat_lon_idx").on(table.latitude, table.longitude),
    // Phase 2.3 — delta-sync cursor scans: GET /sync/assets?cursor=<seq>
    // walks rows in seq order per workspace.
    index("assets_workspace_seq_idx").on(table.workspaceId, table.seq),
  ]
);

export const collections = fontoSchema.table(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    projectId: uuid("project_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Phase 2.3 — delta-sync cursor; see assets.seq.
    seq: bigint("seq", { mode: "bigint" }),
  },
  (table) => [
    index("collections_workspace_id_idx").on(table.workspaceId),
    index("collections_project_id_idx").on(table.projectId),
    index("collections_workspace_seq_idx").on(table.workspaceId, table.seq),
  ]
);

export const collectionAssets = fontoSchema.table(
  "collection_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("collection_assets_collection_id_idx").on(table.collectionId),
    index("collection_assets_asset_id_idx").on(table.assetId),
  ]
);

export const tags = fontoSchema.table(
  "tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    aiSuggested: boolean("ai_suggested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Phase 2.3 — delta-sync cursor; see assets.seq.
    seq: bigint("seq", { mode: "bigint" }),
  },
  (table) => [
    index("tags_workspace_id_idx").on(table.workspaceId),
    index("tags_workspace_seq_idx").on(table.workspaceId, table.seq),
  ]
);

export const assetTags = fontoSchema.table(
  "asset_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("asset_tags_asset_id_idx").on(table.assetId),
    index("asset_tags_tag_id_idx").on(table.tagId),
  ]
);

export const uploadSessions = fontoSchema.table(
  "upload_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    uploadId: text("upload_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    assetId: uuid("asset_id"),
    state: text("state").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("upload_sessions_upload_id_idx").on(table.uploadId),
    index("upload_sessions_user_id_idx").on(table.userId),
  ]
);

// Presigned direct-to-R2 upload tracking (Phase 1.2).
// One row per `/assets/init` call: reserves an R2 key and a server-issued
// presigned PUT URL, then transitions to `completed` (with FK to the new
// asset row) or `aborted`. Distinct from `upload_sessions` — that table
// powers idempotency of the legacy multipart POST and stays untouched.
export const assetUploads = fontoSchema.table(
  "asset_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // Optional client-provided SHA-256 (lowercase hex). When present AND
    // SKIP_SERVER_CHECKSUM is set, /complete trusts it and skips the
    // server-side stream-hash pass.
    clientChecksum: text("client_checksum"),
    // R2 object key reserved at init time. Format matches assetStorageKey().
    storageKey: text("storage_key").notNull(),
    // pending | completed | aborted
    state: text("state").notNull().default("pending"),
    presignedExpiresAt: timestamp("presigned_expires_at", { withTimezone: true }).notNull(),
    // Populated when state -> completed. FK to fonto.assets.id (enforced in SQL).
    assetId: uuid("asset_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("asset_uploads_workspace_state_idx").on(table.workspaceId, table.state),
    index("asset_uploads_user_state_idx").on(table.userId, table.state),
  ]
);

export const smartCollections = fontoSchema.table(
  "smart_collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    query: jsonb("query").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("smart_collections_workspace_id_idx").on(table.workspaceId)]
);

export const projects = fontoSchema.table(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("projects_workspace_id_idx").on(table.workspaceId)]
);

export const correspondents = fontoSchema.table(
  "correspondents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    matchPattern: text("match_pattern"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("correspondents_workspace_id_idx").on(table.workspaceId)]
);

export const documentTypes = fontoSchema.table(
  "document_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    matchPattern: text("match_pattern"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("document_types_workspace_id_idx").on(table.workspaceId)]
);

// Phase 1.4: resumable/chunked uploads via tus.
//
// One row per tus upload-id. Tracks the upload through its lifecycle so we
// can resume across client reconnects and reconcile a finished tus upload
// with the eventual `assets` row we materialize on completion.
//
// This table is intentionally minimal. Phase 1.2 introduces a more general
// `assetUploads` table that will subsume this — the integration agent will
// collapse the two; until then the columns here mirror the names Phase 1.2
// is expected to use so the migration is mechanical.
export const tusUploads = fontoSchema.table(
  "tus_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The tus-server upload ID (random hex, used as the URL segment).
    uploadId: text("upload_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // Original filename advertised by the client in Upload-Metadata.
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    // Declared total size in bytes (may be null for deferred-length uploads,
    // though we currently refuse those — declared size is required).
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // open | completed | aborted
    state: text("state").notNull().default("open"),
    // Once tus signals POST_FINISH and we materialize an `assets` row, we
    // stamp the new asset's id here so future HEAD/GET requests can find it.
    assetId: uuid("asset_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("tus_uploads_upload_id_idx").on(table.uploadId),
    index("tus_uploads_user_id_idx").on(table.userId),
    index("tus_uploads_workspace_id_idx").on(table.workspaceId),
  ]
);

// Phase 2.3 — per-workspace monotonic counters powering delta sync. One row
// per workspace; each `nextSeq()` call atomically increments and returns the
// new value for the requested entity kind. Rows are created lazily via
// INSERT ... ON CONFLICT DO UPDATE so brand-new workspaces don't need a
// dedicated setup step.
export const workspaceSeq = fontoSchema.table("workspace_seq", {
  workspaceId: uuid("workspace_id").primaryKey(),
  assetSeq: bigint("asset_seq", { mode: "bigint" }).notNull().default(sql`0`),
  tagSeq: bigint("tag_seq", { mode: "bigint" }).notNull().default(sql`0`),
  collectionSeq: bigint("collection_seq", { mode: "bigint" }).notNull().default(sql`0`),
});

// Public, time-bounded share tokens for individual assets.
// `token` is a URL-safe random string. `expiresAt` is enforced at access time;
// `revokedAt` lets owners kill a link without waiting for expiry.
export const shareLinks = fontoSchema.table(
  "share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    token: text("token").notNull().unique(),
    createdBy: text("created_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("share_links_token_idx").on(table.token),
    index("share_links_asset_id_idx").on(table.assetId),
  ]
);
