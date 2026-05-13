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
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("assets_workspace_id_idx").on(table.workspaceId),
    index("assets_mime_type_idx").on(table.mimeType),
    index("assets_lifecycle_state_idx").on(table.lifecycleState),
    index("assets_processing_state_idx").on(table.processingState),
    index("assets_ocr_state_idx").on(table.ocrState),
    index("assets_phash_idx").on(table.phash),
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
  },
  (table) => [
    index("collections_workspace_id_idx").on(table.workspaceId),
    index("collections_project_id_idx").on(table.projectId),
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
  },
  (table) => [index("tags_workspace_id_idx").on(table.workspaceId)]
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
