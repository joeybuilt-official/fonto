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

// Phase 3.1 — multi-user workspace memberships (ADR 0004).
//
// `workspaces.user_id` remains the canonical "personal owner" pointer for one
// release. This table is the authoritative source going forward — every
// authz decision (`assertWorkspaceAccess` in lib/authz.ts) reads from here.
//
// Roles (text, CHECK in migration 0012):
//   - 'owner'  — one per workspace, billing + delete + member management
//   - 'editor' — upload, edit, delete assets; cannot remove the owner
//   - 'viewer' — read-only
//
// Backfill (migration 0012): one membership row per existing workspace,
// role='owner', userId = workspaces.user_id, createdBy = NULL.
//
// `createdBy` is the inviter's user id; NULL for backfilled owners and any
// auto-provisioned membership that didn't come through an invite (the
// invitation table arrives in Phase 3.3 — migration 0014).
export const workspaceMemberships = fontoSchema.table(
  "workspace_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Matches Better Auth `user.id` (text). Cross-schema, FK enforced in SQL.
    userId: text("user_id").notNull(),
    // 'owner' | 'editor' | 'viewer' — CHECK constraint in SQL.
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Inviter's user id; NULL for backfilled owners.
    createdBy: text("created_by"),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_idx").on(
      table.workspaceId,
      table.userId
    ),
    // "What workspaces can this user see?" — the hot path of getUserWorkspaces.
    index("workspace_memberships_user_idx").on(table.userId),
    // "Who's an editor in this workspace?" — member-list + invite-flow queries.
    index("workspace_memberships_workspace_role_idx").on(
      table.workspaceId,
      table.role
    ),
  ]
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
    // Phase 3.4 — favorites + 0..5 star ratings. `isFavorite` is a binary
    // "loved" toggle (heart icon); `rating` is a 0..5 integer where 0 means
    // "unrated". Both are surfaced as filter chips on the timeline and as
    // smart-collection facets (`{ "favorite": true }`, `{ "ratingMin": N }`).
    isFavorite: boolean("is_favorite").notNull().default(false),
    rating: integer("rating").notNull().default(0),
    // Phase 3.5 — virtual folder path (Immich-style). Captures the source
    // directory of the upload so users can browse by the directory tree they
    // came from. Stored as a normalised string (leading `/`, no trailing
    // `/`, no `..` segments); see `lib/folders/normalize.ts`. NULL means
    // "lives at workspace root" — no folder. There is intentionally no
    // `folders` table; folders are GROUP BY prefixes of this column.
    directoryPath: text("directory_path"),
    // Phase 4.6 — zero-shot CLIP classification metadata.
    //   subClassification: chosen sub-taxonomy key (e.g. "food", "portrait").
    //     NULL if the top-level had no subs or confidence was too low.
    //   classifyMethod: which path produced the classification — "clip" for
    //     the cheap zero-shot path, "llm-fallback" when CLIP was uncertain
    //     and we asked the vision-LLM. Used for both metrics and future
    //     re-classification sweeps.
    //   classifyConfidence: top-1 cosine in [0, 1]. For LLM fallback this
    //     is the CLIP score we *would* have used (often near 0).
    //   autoTaggedAt: stamp on each successful auto-tag pass; lets a future
    //     backfill cron find rows that need re-tagging when the taxonomy
    //     or threshold changes.
    subClassification: text("sub_classification"),
    classifyMethod: text("classify_method"),
    classifyConfidence: real("classify_confidence"),
    autoTaggedAt: timestamp("auto_tagged_at", { withTimezone: true }),
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
    // Phase 3.4 — favorites/ratings facets. Partial indexes keep the BTree
    // small (most assets are neither favorited nor rated).
    index("assets_workspace_favorite_idx")
      .on(table.workspaceId)
      .where(sql`${table.isFavorite} = true`),
    index("assets_workspace_rating_idx")
      .on(table.workspaceId, table.rating)
      .where(sql`${table.rating} > 0`),
    // Phase 3.5 — folder listing prefix scans
    // (`WHERE workspace_id = $1 AND directory_path LIKE '/Photos/%'`).
    index("assets_workspace_directory_path_idx").on(
      table.workspaceId,
      table.directoryPath
    ),
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
    // Phase 3.5 — optional folder path the client passed at /init time.
    // Normalised + persisted here so /complete can pour it into the assets
    // row without trusting the client to re-send it. See
    // `lib/folders/normalize.ts`.
    directoryPath: text("directory_path"),
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

// Phase 2.4 — Outbound webhooks.
//
// `webhook_endpoints` is the user-facing registration row: a URL, a signing
// secret (32-byte random hex generated server-side), and the list of event
// types the endpoint wants. `enabledEvents` is a Postgres text[] so we can
// index/query it cheaply with `= ANY(enabled_events)`.
//
// `webhook_deliveries` is the per-attempt log: one row per (endpoint, event)
// pair created by `emitWebhook()`. The BullMQ `webhook-delivery` queue pulls
// these rows by id, POSTs the payload, and updates the `state` column.
// Retried deliveries reuse the same row (incrementing `attempts`).
export const webhookEndpoints = fontoSchema.table(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    url: text("url").notNull(),
    // 32-byte hex (64 chars). Generated by the create route; surfaced once
    // to the caller, then never returned in plaintext again.
    signingSecret: text("signing_secret").notNull(),
    // Postgres text[]. Names match `WebhookEventType` in lib/webhooks/events.ts.
    enabledEvents: text("enabled_events")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text("description"),
    // NULL = enabled. Setting a timestamp soft-disables the endpoint without
    // losing its history.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("webhook_endpoints_workspace_disabled_idx").on(
      table.workspaceId,
      table.disabledAt
    ),
  ]
);

export const webhookDeliveries = fontoSchema.table(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id").notNull(),
    eventType: text("event_type").notNull(),
    // Full event envelope (the body we POST to the endpoint). jsonb so the
    // worker can re-serialize on each attempt.
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    // pending | delivered | failed
    state: text("state").notNull().default("pending"),
    lastResponseStatus: integer("last_response_status"),
    // Truncated to 8 KiB by the worker before insert.
    lastResponseBody: text("last_response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("webhook_deliveries_endpoint_state_idx").on(table.endpointId, table.state),
    index("webhook_deliveries_next_attempt_idx").on(table.nextAttemptAt),
  ]
);

// Public, time-bounded share tokens.
//
// Phase 2.5 overhaul (see ADR 0004 + ADR 0007 + migration 0011):
//   - `targetType` + `targetId` generalise the link beyond single assets to
//     collections and sets. Old rows are backfilled with targetType='asset'.
//   - `passwordHash` is an argon2id digest; verified timing-safely on resolve.
//   - `allowDownload`, `maxViews`, `viewCount`, `lastAccessedAt` are new
//     capability + analytics knobs.
//   - `assetId` is kept as a redundant column for one release so deployed
//     clients that still read it don't break. TODO: drop in a focused PR.
//   - `revokedAt` continues to live on, but a denormalised boolean `revoked`
//     is added for cheaper indexable filters.
//   - The legacy random `token` column is preserved; new short `slug` (8 char
//     base62) is the public URL segment going forward and is unique-indexed.
export const shareLinks = fontoSchema.table(
  "share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Legacy: kept for one release; new rows still write it (= targetId) so
    // the `notNull` constraint inherited from migration 0001 stays satisfied.
    // TODO(2.6): drop this column once all clients move to targetId.
    assetId: uuid("asset_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // 'asset' | 'collection' | 'set'
    targetType: text("target_type").notNull().default("asset"),
    targetId: uuid("target_id").notNull(),
    // Legacy long random URL-safe token. New rows still get one (mirrored from
    // `slug` for backward compat); the public URL is /share/{slug}.
    token: text("token").notNull().unique(),
    // 8 char base62 — the new public URL segment.
    slug: text("slug").notNull(),
    // Optional argon2id digest. NULL = no password required.
    passwordHash: text("password_hash"),
    allowDownload: boolean("allow_download").notNull().default(true),
    // NULL = unlimited.
    maxViews: integer("max_views"),
    viewCount: integer("view_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    // Optional — NULL means "never expires".
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Denormalised flag for indexable filters; mirrors `revokedAt IS NOT NULL`.
    revoked: boolean("revoked").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("share_links_token_idx").on(table.token),
    uniqueIndex("share_links_slug_idx").on(table.slug),
    index("share_links_asset_id_idx").on(table.assetId),
    index("share_links_target_idx").on(table.targetType, table.targetId),
    index("share_links_workspace_active_idx").on(table.workspaceId, table.revoked),
  ]
);

// Per-access audit trail for share links. Stored for analytics + abuse
// forensics. Privacy: raw IPs are NEVER persisted — only a per-deploy salted
// SHA-256 (`SHARE_LINK_IP_SALT` env). `success=false` rows capture wrong
// password attempts (rate-limit signal).
export const shareLinkViews = fontoSchema.table(
  "share_link_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shareLinkId: uuid("share_link_id").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).defaultNow().notNull(),
    // sha256(SHARE_LINK_IP_SALT + ip), hex. Coarse — fine for rate analytics.
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    success: boolean("success").notNull().default(true),
    // Truncated to 500 chars at write time.
    referer: text("referer"),
  },
  (table) => [
    index("share_link_views_link_accessed_idx").on(
      table.shareLinkId,
      sql`${table.accessedAt} desc`
    ),
  ]
);

// Phase 2.1: Personal Access Tokens (PATs).
//
// Programmatic API auth for mobile + CLI clients. The plaintext token is shown
// to the user exactly once at creation time; only a SHA-256 digest is stored.
// The format on the wire is `fonto_pat_<id>_<secret>` — we prefix-route to
// this table and verify by recomputing the digest and timing-safe-comparing.
//
// Rationale: Better Auth's apiKey plugin doesn't ship in 1.6.9 (the installed
// version), so we own the table and the verifier. The shape mirrors what the
// plugin would have given us (id, name, prefix, hash, last_used_at, scopes,
// expires_at) so a future swap to the plugin would be a column-rename, not a
// rewrite. Token shape is what the plan calls for: `fonto_pat_` prefix, both
// `Authorization: Bearer` and `x-api-key` accepted, scopes = read/write/admin.
// Phase 3.2 — append-only audit log.
//
// Records every state-mutating action a user performs in the workspace
// (asset upload/update/delete, share create/revoke, token mint/revoke,
// webhook CRUD, etc.). The log is append-only: no UPDATE, no DELETE except
// by the retention reaper (default 90d, `AUDIT_RETENTION_DAYS`).
//
// Privacy notes:
//   - Raw IPs are NEVER persisted. The `ipAddress` column stores the IP
//     truncated to /24 (IPv4) or /48 (IPv6). Same stance as Phase 2.5's
//     share_link_views (which hashes; here we truncate because the data is
//     consumed by the workspace owner and a coarse subnet is enough to
//     spot rogue/foreign access without enabling per-user tracking).
//   - `userAgent` is truncated to 500 chars at write time.
//
// `workspaceId` is nullable because some events are user-scoped rather than
// workspace-scoped (e.g. token.mint / token.revoke happen against a user,
// not a single workspace). Workspace-scoped events MUST set it.
//
// `targetId` is `text` (not uuid) because some targets are slugs (shares),
// hex secrets (tokens), or composite keys we may want to extend.
export const auditLog = fontoSchema.table(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id"),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    // IPv4 truncated to /24, IPv6 truncated to /48. NEVER the raw IP.
    ipAddress: text("ip_address"),
    // Truncated to 500 chars at write time.
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_workspace_created_idx").on(
      table.workspaceId,
      sql`${table.createdAt} desc`
    ),
    index("audit_log_user_created_idx").on(
      table.userId,
      sql`${table.createdAt} desc`
    ),
    index("audit_log_action_created_idx").on(
      table.action,
      sql`${table.createdAt} desc`
    ),
  ]
);

export const apiKeys = fontoSchema.table(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Owner of the token. Foreign key into Better Auth's `auth.user` table —
    // we don't enforce the FK here (cross-schema), but the column matches
    // Better Auth's `user.id` (text). On user-delete the orchestration layer
    // is expected to revoke; if it doesn't, `verifyPat` returns null because
    // the loaded user comes from `auth.api.getUserById`.
    userId: text("user_id").notNull(),
    // Human-readable label for the UI ("Macbook CLI", "iPhone backup").
    name: text("name").notNull(),
    // Public, low-entropy prefix used to identify the key class at a glance.
    // Defaults to `fonto_pat_` (per the parity plan).
    prefix: text("prefix").notNull().default("fonto_pat_"),
    // First 4 chars of the secret (NOT the prefix) shown in the UI so users
    // can identify a key without revealing it. Pure UX, not a security feature.
    firstFour: text("first_four").notNull(),
    // Last 4 chars of the secret shown in the UI.
    lastFour: text("last_four").notNull(),
    // SHA-256 hex digest of the secret portion (the part after the prefix and
    // the id). Verification: re-hash the candidate secret, timing-safe compare.
    secretHash: text("secret_hash").notNull(),
    // Granted scopes — subset of ["read","write","admin"]. Stored as JSONB so
    // we can grow the vocabulary without a migration (e.g. add "delete" later).
    scopes: jsonb("scopes").notNull().default(sql`'["read"]'::jsonb`),
    // Free-form metadata (e.g. originating client, last-known IP). Off by
    // default; enabled per-token via `metadata` field on create.
    metadata: jsonb("metadata"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("api_keys_user_id_idx").on(table.userId),
    index("api_keys_secret_hash_idx").on(table.secretHash),
  ]
);

// Phase 3.3 — workspace invitations.
//
// Email-keyed invitations that produce `workspace_memberships` rows on
// acceptance. See ADR 0004 for the full multi-user model.
//
// Token storage: PLAINTEXT random 32-byte URL-safe value (unlike PATs which
// are hashed). Rationale: invitations are short-lived (7 days), have one
// acceptable use, and the settings UI needs to be able to re-show the URL
// when the original recipient has lost the email. The attack surface is
// dramatically smaller than for long-lived PATs.
export const workspaceInvitations = fontoSchema.table(
  "workspace_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Invited address. Compared case-insensitively against `auth.user.email`
    // at acceptance time. We store the canonical lowercased form on insert.
    email: text("email").notNull(),
    // Role granted on acceptance. Owners cannot be invited — they're minted
    // when the workspace is created. Promote a member to owner via a future
    // membership-update endpoint, not by re-inviting.
    role: text("role").notNull(),
    // Random 32-byte base64url. Used as the public URL segment AND the
    // lookup key — see comment above.
    token: text("token").notNull(),
    // Better Auth `user.id` of the inviter. Used to render "X invited you"
    // on the accept page.
    invitedBy: text("invited_by").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    // Resolved at acceptance — the Better Auth `user.id` of the user that
    // claimed the invite. NULL until acceptance.
    acceptedByUserId: text("accepted_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Hard cap, default 7 days from create. Override via env
    // `WORKSPACE_INVITATION_TTL_DAYS`.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Tokens are unique — the lookup key for /accept and the public GET.
    uniqueIndex("workspace_invitations_token_idx").on(table.token),
    // "Pending invitations in this workspace" — the settings UI filters
    // on (workspaceId, acceptedAt IS NULL, revokedAt IS NULL, expiresAt > now).
    index("workspace_invitations_workspace_state_idx").on(
      table.workspaceId,
      table.acceptedAt,
      table.revokedAt,
      table.expiresAt
    ),
    // "All invitations addressed to <email>" — used to surface pending
    // invitations after a new user completes signup with `?invitation=`.
    index("workspace_invitations_email_idx").on(table.email),
  ]
);
