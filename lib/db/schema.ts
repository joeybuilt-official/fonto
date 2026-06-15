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
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "./drizzle-vector";

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
    // Phase 9.1 — storage quotas. quota_bytes = NULL means unlimited.
    // usage_bytes is maintained incrementally (incremented on upload complete,
    // decremented on hard delete) and reconciled nightly.
    quotaBytes: bigint("quota_bytes", { mode: "number" }),
    usageBytes: bigint("usage_bytes", { mode: "number" }).notNull().default(0),
    // Storage placement (Track B / migration 0040): 'r2_only'|'mirror'|'local_only',
    // CHECK in SQL. Default r2_only = cloud-only (today's behavior). Per-asset
    // override lives on assets.storage_policy_override.
    storagePolicy: text("storage_policy").notNull().default("r2_only"),
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
    // User marked this photo "no faces here" — skip detection + hide any
    // existing faces from People (faces/UX ignore feature).
    facesIgnored: boolean("faces_ignored").notNull().default(false),
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
    // For PaddleOCR PP-OCRv5 (Phase 4.4) this is the concatenated text from
    // all detected lines, joined with newlines.
    ocrText: text("ocr_text"),
    // OCR pipeline state:
    //   pending  — image asset, hasn't been processed yet (default).
    //   ready    — OCR ran and produced text (ocr_text non-empty).
    //   empty    — OCR ran successfully but found no text. Phase 4.4: with
    //              PaddleOCR this is a legitimate, distinct outcome —
    //              e.g. solid-color photos, abstract art, blurred snaps.
    //              Distinct from `skipped` (we didn't try) and from
    //              `failed` (we tried and the model errored).
    //   failed   — OCR pipeline errored (model unreachable, decode error,
    //              etc.). Backfill cron will retry by leaving this row to
    //              be reset to 'pending' by an operator.
    //   skipped  — non-image MIME type; OCR was never attempted.
    ocrState: text("ocr_state").notNull().default("pending"),
    // Phase 4.4 — per-line OCR bounding boxes for the lightbox text-region
    // highlighter. `[{ text, bbox: [x, y, w, h], confidence }, ...]`.
    // NULL if OCR hasn't run, ran via the legacy LLM fallback, or found
    // no text. Bbox coordinates are in source image pixel space.
    ocrBoxes: jsonb("ocr_boxes"),
    // Full raw EXIF/IPTC/XMP metadata blob extracted at ingest. NULL for
    // non-image assets or when extraction fails. See lib/exif.ts.
    exif: jsonb("exif"),
    // GPS coordinates lifted out of EXIF for indexable map queries.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    // Phase 5.2 — reverse-geocoded place name ("Reykjavík, IS") derived from
    // (latitude, longitude) via the offline GeoNames cities500 dataset (see
    // `lib/geocoder.ts`). NULL when either coord is missing, the geocoder
    // hasn't run yet, or no city lies within ~200 km (open ocean, polar).
    placeName: text("place_name"),
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
    // Phase 4.3 (ADR 0002) — CLIP image embedding for text-to-image search
    // and visual-similarity dedup. 512-dim float vector, populated by the
    // Phase 4.2 backfill worker. NULL until computed. Cosine-distance HNSW
    // index is partial (`WHERE clip_vec IS NOT NULL`) so unbackfilled rows
    // don't bloat the index — see migration 0017.
    clipVec: vector("clip_vec", 512),
    // Phase 4.5 — timestamp the CLIP-similarity dedup pass last ran for this
    // asset (either inline at upload time or via the worker fallback). NULL
    // means "not yet checked".
    clipDedupCheckedAt: timestamp("clip_dedup_checked_at", { withTimezone: true }),
    // Phase 4.6 — zero-shot CLIP classification metadata.
    //   subClassification: chosen sub-taxonomy key (e.g. "food", "portrait").
    //   classifyMethod: "clip" (cheap) | "llm-fallback" (CLIP was uncertain).
    //   classifyConfidence: top-1 cosine in [0, 1].
    //   autoTaggedAt: stamp on each successful auto-tag pass.
    subClassification: text("sub_classification"),
    classifyMethod: text("classify_method"),
    classifyConfidence: real("classify_confidence"),
    autoTaggedAt: timestamp("auto_tagged_at", { withTimezone: true }),
    // Phase 5.5 — manual stacks. NULL = standalone asset. When set, the row
    // belongs to a `fonto.stacks` group and the timeline hides it unless the
    // asset is the stack's `primaryAssetId` (or the caller opts in to
    // `?expandStacks=true`). FK is soft-enforced in SQL (matches the same
    // approach as `correspondentId` / `documentTypeId`).
    stackId: uuid("stack_id"),
    // Phase 8a — video probe output. NULL for non-video assets.
    durationSeconds: doublePrecision("duration_seconds"),
    videoCodec: text("video_codec"),
    videoWidth: integer("video_width"),
    videoHeight: integer("video_height"),
    // Phase 8b — HLS ladder transcode state.
    //   'idle'         — no transcode has been requested yet.
    //   'transcoding'  — job is in flight; the player UI shows a
    //                    progress spinner.
    //   'ready'        — all renditions in R2, master.m3u8 written;
    //                    `hlsMasterKey` + `hlsRenditions` are non-null.
    //   'failed'       — last attempt threw; safe to re-enqueue
    //                    (transcoder is idempotent + overwrites).
    // CHECK constraint enforced in migration 0029.
    hlsState: text("hls_state").notNull().default("idle"),
    hlsMasterKey: text("hls_master_key"),
    // Array of { name, key, width, height, bitrateKbps, codec }. One
    // element per rendition in the ladder (typically 3: 360p/720p/
    // 1080p — see lib/processing/transcodeVideoHls.ts for the canonical
    // ladder definition). Future-proof for adaptive additions w/o a
    // schema change.
    hlsRenditions: jsonb("hls_renditions"),
    // 10s-interval thumbnail sprite for hover-scrub preview on the
    // video scrubber. Generated alongside the HLS transcode so the
    // player has it on first ready.
    spriteKey: text("sprite_key"),
    // { interval, columns, rows, tileWidth, tileHeight, totalFrames }.
    // The hover-scrub UI multiplies hover % * totalFrames to pick a
    // tile, then derives row/col from columns to set background-position.
    spriteMeta: jsonb("sprite_meta"),
    // Phase 6.7 — page count for multi-page documents (PDFs from the mobile
    // scanner). NULL for non-document assets; populated by the worker via
    // pdfinfo during processAsset.
    pageCount: integer("page_count"),
    // Task 20 — KIND: the library's primary partition (moment | screenshot |
    // document | video). Deterministic function of (mimeType, classification)
    // via `lib/classify/kind.ts:deriveKind`, written alongside classification
    // in processAsset. NULL until resolved (the in-flight `captured` backlog
    // self-populates as the worker drains it; `ready` rows are backfilled
    // once). Drives the lens-based library + bucket facets.
    kind: text("kind"),
    // ADR 0008 — scope partition. Authoritative single-valued classification
    // that drives DEFAULT behavior (timeline / On This Day / search default to
    // PERSONAL). 'PERSONAL' (default) = personal life capture; 'SHOOT' = any
    // deliberate session, professional or hobby. CHECK enforced in migration
    // 0041. Existing rows backfill to PERSONAL via the column default.
    scope: text("scope").notNull().default("PERSONAL"),
    // ADR 0008 — N:1 soft FK to fonto.shoots (matches correspondentId style; no
    // DB FK constraint). NULL unless the asset belongs to a filed session.
    shootId: uuid("shoot_id"),
    // ADR 0008 — per-asset stage within its shoot. CHECK (RAW | SELECTS |
    // DELIVERED | REJECTS) in migration 0041. NULL = unfiled / not a shoot asset.
    shootStage: text("shoot_stage"),
    // Storage placement (Track B / migration 0040). `storagePolicyOverride`
    // NULL = inherit the workspace policy (the common case); a value pins this
    // one asset. `localOriginalStoredAt` NULL = the ORIGINAL has no verified
    // local copy; a timestamp = a size/etag-verified local copy exists (set by
    // the mirror/backfill workers). Derivatives are never localized (C2).
    storagePolicyOverride: text("storage_policy_override"),
    localOriginalStoredAt: timestamp("local_original_stored_at", { withTimezone: true }),
    // Task #32 (rotate / crop transform). When a transform endpoint persists
    // the result as a NEW asset (every crop, optionally a rotate), this points
    // at the asset the user transformed from. NULL = an original ingest, never
    // derived. Soft FK with ON DELETE SET NULL in SQL (migration 0042) so a
    // hard-delete of the original leaves the derivative as a standalone row
    // rather than cascade-deleting user-edited copies.
    derivedFromAssetId: uuid("derived_from_asset_id"),
    // Intelligence Core (ADR-0002 / migration 0044) — variant consolidation.
    // `variantGroupId` is a soft FK to fonto.variant_groups: NULL = not (yet) a
    // near-dup candidate. `isCanonical` marks the survivor Phase 5 picked.
    // `qualityMetrics` is the deterministic scorer output { sharpness, artifact,
    // bytesPerPixel, origVsDerived, score }. `consolidationState` + `trashPurgeAt`
    // are kept SEPARATE from the deleted/archived/purged lifecycle so a variant
    // purge never conflates with a user delete; 'trashed' rows wait out the grace
    // window in `trashPurgeAt` before a Phase 5 hard purge.
    variantGroupId: uuid("variant_group_id"),
    isCanonical: boolean("is_canonical").notNull().default(false),
    qualityMetrics: jsonb("quality_metrics"),
    consolidationState: text("consolidation_state").notNull().default("none"),
    trashPurgeAt: timestamp("trash_purge_at", { withTimezone: true }),
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
    // Phase 4.5 — partial index for the CLIP-dedup worker sweep: it picks
    // rows where the embedding is present but the dedup check hasn't run.
    // Partial so the index stays small (most active rows are either still
    // pending an embed or already checked).
    index("assets_clip_dedup_pending_idx")
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.clipDedupCheckedAt} IS NULL`),
    // Phase 5.5 — partial index on (workspace_id, stack_id) restricted to
    // assets that actually belong to a stack. Lets the lightbox "expand
    // stack" query and the suggester membership scans run from a small
    // index instead of the full assets table.
    index("assets_workspace_stack_idx")
      .on(table.workspaceId, table.stackId)
      .where(sql`${table.stackId} IS NOT NULL`),
    // Task 20 — lens faceting + per-kind bucket counts. Partial on active
    // rows (the only rows any lens lists) keeps the BTree small.
    index("assets_workspace_kind_idx")
      .on(table.workspaceId, table.kind)
      .where(sql`${table.lifecycleState} = 'active'`),
    // ADR 0008 — default timeline/feed: workspace assets of one scope ordered
    // by capture date. Serves the PERSONAL-default feed + the SHOOT browser.
    index("assets_workspace_scope_captured_idx").on(
      table.workspaceId,
      table.scope,
      sql`${table.capturedAt} desc`
    ),
    // ADR 0008 — shoot membership scans (browse a session's assets). Partial on
    // filed shoot assets keeps the BTree small.
    index("assets_shoot_id_idx")
      .on(table.shootId)
      .where(sql`${table.shootId} IS NOT NULL`),
    // Task #32 — reverse lookup "find children of asset X" (every crop /
    // rotate-as-new derived from this asset). Partial on derived rows only so
    // the BTree stays small (the vast majority of assets are originals).
    index("assets_derived_from_idx")
      .on(table.derivedFromAssetId)
      .where(sql`${table.derivedFromAssetId} IS NOT NULL`),
    // Intelligence Core (migration 0044) — list a variant group's members.
    // Partial on grouped rows (the minority) keeps the BTree small.
    index("assets_variant_group_idx")
      .on(table.variantGroupId)
      .where(sql`${table.variantGroupId} IS NOT NULL`),
    // Intelligence Core (migration 0044) — Phase 5 purge sweep picks trashed
    // variants past their grace window.
    index("assets_trash_purge_at_idx")
      .on(table.trashPurgeAt)
      .where(sql`${table.trashPurgeAt} IS NOT NULL`),
  ]
);

// Phase 5.5 — manual stacks.
//
// A stack is a group of related assets where one is "primary" — RAW+JPEG of
// the same shot, an iPhone burst, multiple edits of the same photo. The
// timeline shows only the primary; clicking expands the rest of the stack
// inline in the lightbox.
//
// Membership lives on `assets.stack_id`: every member row has its
// `stack_id` pointing here. The `primary_asset_id` here points to whichever
// member should represent the stack in the timeline. Both directions are
// soft FKs (no enforced DB FK) — same approach as `correspondentId` on
// assets. We always own the lifecycle in the route handlers: when a stack
// is deleted, members are un-stacked first (`stack_id = NULL`); when the
// primary is removed from a stack, the next-oldest member is promoted.
//
// Suggestion is a separate, read-only pass (`lib/stacks/suggest.ts`) — the
// suggester flags candidate clusters but never writes; the user confirms
// each suggestion via `POST /api/v1/stacks/suggestions/accept`.
export const stacks = fontoSchema.table(
  "stacks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Soft FK to `assets.id`. The handler ensures this asset's `stack_id`
    // equals the stack's id at all times.
    primaryAssetId: uuid("primary_asset_id").notNull(),
    // Optional display name (e.g. "Sunset, 2024-06-18"). NULL = unnamed.
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("stacks_workspace_id_idx").on(table.workspaceId),
    index("stacks_primary_asset_id_idx").on(table.primaryAssetId),
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

// ADR 0008 — scope partition: SHOOT organization (Client? -> Shoot -> Stage).
//
// A `client` is the optional parent of a professional shoot. Hobby shoots have
// no client. Soft FKs throughout (no enforced DB FK) — matches the schema's
// `correspondentId`/`stackId` style; route handlers own lifecycle.
export const clients = fontoSchema.table(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Phase 2.3 — delta-sync cursor; see assets.seq.
    seq: bigint("seq", { mode: "bigint" }),
  },
  (table) => [
    index("clients_workspace_id_idx").on(table.workspaceId),
    index("clients_workspace_seq_idx").on(table.workspaceId, table.seq),
  ]
);

// A `shoot` is one deliberate session. `clientId` NULL = hobby shoot; set =
// professional. `paid`/`kind`/`consentStatus` are shoot attributes — the
// pro/hobby distinction lives HERE, not as a top-level scope value.
export const shoots = fontoSchema.table(
  "shoots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    // Soft FK to fonto.clients.id. NULL = hobby shoot (no client).
    clientId: uuid("client_id"),
    name: text("name").notNull(),
    shootDate: date("shoot_date"),
    // Free-ish session kind ("wedding" | "senior" | "children" | "hobby" | ...).
    kind: text("kind"),
    paid: boolean("paid").notNull().default(false),
    // Model-release / consent status; drives sharing policy. NULL = unset.
    consentStatus: text("consent_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Phase 2.3 — delta-sync cursor; see assets.seq.
    seq: bigint("seq", { mode: "bigint" }),
  },
  (table) => [
    index("shoots_workspace_id_idx").on(table.workspaceId),
    index("shoots_client_id_idx").on(table.clientId),
    index("shoots_workspace_seq_idx").on(table.workspaceId, table.seq),
  ]
);

// Reversible ledger for bulk scope reassignment (ADR 0008 D6). One row per
// asset whose scope actually changed in a batch. UNIQUE(asset_id, batch_id)
// makes batch re-runs idempotent; any batch can be undone by replaying the
// from_* values. No rename/delete is ever done — reassignment only mutates
// the scope/shoot_id columns, which this ledger records.
export const scopeReassignments = fontoSchema.table(
  "scope_reassignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    fromScope: text("from_scope").notNull(),
    toScope: text("to_scope").notNull(),
    fromShootId: uuid("from_shoot_id"),
    toShootId: uuid("to_shoot_id"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("scope_reassignments_asset_batch_idx").on(table.assetId, table.batchId),
    index("scope_reassignments_batch_idx").on(table.batchId),
    index("scope_reassignments_workspace_idx").on(table.workspaceId),
  ]
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

// Phase 5.1 — face detection + ArcFace embedding + DBSCAN clustering.
//
// Two tables (see drizzle/migrations/0021_faces_persons.sql, already landed
// in main + prod):
//
//   - `persons`         — one row per clustered identity. Built by the
//                         DBSCAN clusterer in lib/faces/cluster.ts. Name +
//                         cover face are user-edited via the People page.
//   - `face_instances`  — one row per detected face on an asset. Carries
//                         the normalised bbox, ArcFace 512-dim L2-normalised
//                         embedding, detection confidence, and an optional
//                         FK to a `persons` cluster.
//
// FKs across both directions are intentionally soft (matching the rest of
// the schema's `correspondentId`/`documentTypeId` style). The route handlers
// own lifecycle: delete a person -> faces detach (person_id = NULL); hide a
// face -> excluded from the next clustering pass.
export const persons = fontoSchema.table(
  "persons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // User-assigned display name. NULL = unnamed cluster (UI shows
    // "Unnamed person" + cover thumbnail).
    name: text("name"),
    // Soft FK to face_instances.id — the avatar face. NULL = "fall back to
    // the first face in the cluster" at render time.
    coverFaceId: uuid("cover_face_id"),
    // Hidden from the People page grid (false positives, strangers, kids
    // the user doesn't want surfaced). Faces stay attached; only the
    // cluster card is suppressed.
    hidden: boolean("hidden").notNull().default(false),
    // Denormalised count of face_instances pointing at this person. Kept
    // in sync by the clusterer + merge/split route handlers.
    instanceCount: integer("instance_count").notNull().default(0),
    // Intelligence Core (ADR-0002) — temporal anchors for date inference.
    // Birth/death are attached to the PERSON, never the face cluster (a face
    // at 4 vs 40 may not cluster). Stored as a partial date: the `*_date`
    // column normalised to first-of-period + a precision tag {year|month|day}.
    // year-only birthdays are the common case ("born 2004"). NULL = unknown.
    birthDate: date("birth_date"),
    birthPrecision: text("birth_precision"), // 'year' | 'month' | 'day' (CHECK in 0043)
    deathDate: date("death_date"),
    deathPrecision: text("death_precision"), // 'year' | 'month' | 'day' (CHECK in 0043)
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // People page grid: list workspace persons (excluding hidden) ordered
    // by instance count desc. Matches the SQL index in 0021.
    index("persons_workspace_visible_idx").on(
      table.workspaceId,
      table.hidden,
      sql`${table.instanceCount} desc`
    ),
  ]
);

export const faceInstances = fontoSchema.table(
  "face_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // Normalised bounding box (0..1) — { x, y, w, h }. Stored as jsonb for
    // forward-compatibility (future: landmarks array, pose vector).
    bbox: jsonb("bbox").notNull(),
    // Detection confidence (RetinaFace / equivalent). 0..1.
    confidence: real("confidence").notNull(),
    // ArcFace 512-dim embedding. Unit-norm so cosine distance is
    // 1 - dot(a, b). NULL between detect and embed steps.
    embedding: vector("embedding", 512),
    // DBSCAN cluster assignment. NULL means the face hasn't been clustered
    // yet, or landed in DBSCAN noise (no cluster met minPts).
    personId: uuid("person_id"),
    // Phase 1 (faces/UX) — R2 key of the dedicated square face-crop derivative
    // (sharp `.extract` of bbox + ~30% padding, EXIF-correct, ~256px webp) at
    // `derivatives/face/{faceId}.webp`. NULL until the crop lands (new faces
    // crop inline at detect; existing faces via the `backfill-face-crops`
    // maintenance job). Served to web + app so face circles are sharp +
    // centered instead of CSS-zooming a whole-frame derivative.
    faceCropKey: text("face_crop_key"),
    // User-hidden flag (false positives, strangers). Hidden faces are
    // excluded from clustering inputs on the next run.
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("face_instances_workspace_person_idx").on(
      table.workspaceId,
      table.personId
    ),
    index("face_instances_asset_idx").on(table.assetId),
    // Phase 1 (faces/UX) — the `backfill-face-crops` sweep scans for faces
    // with no crop yet. Partial index keeps that "WHERE face_crop_key IS NULL"
    // probe cheap as the column fills in. Matches 0034.
    index("face_instances_crop_pending_idx")
      .on(table.workspaceId)
      .where(sql`${table.faceCropKey} IS NULL`),
    // The HNSW pgvector index is declared in 0021 directly via raw SQL
    // (Drizzle's index builder doesn't speak HNSW); we don't redeclare it
    // here.
  ]
);

// Phase 6 (faces/UX) — person groups (Family, Friends, Colleagues, …).
//
// Two tables:
//   person_groups       — label rows. workspace_id = NULL means built-in
//                         (shared across all workspaces). Non-null = custom
//                         group created by the workspace owner.
//   person_group_members — many-to-many. A person can belong to 0..N groups.
//                         Cascade-deletes when either the person or group row
//                         is removed.
export const personGroups = fontoSchema.table(
  "person_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id"), // NULL = built-in
    name: text("name").notNull(),
    color: text("color").notNull().default("#6b7280"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("person_groups_workspace_name_idx").on(
      table.workspaceId,
      table.name
    ),
    index("person_groups_workspace_idx").on(table.workspaceId),
  ]
);

export const personGroupMembers = fontoSchema.table(
  "person_group_members",
  {
    personId: uuid("person_id").notNull(),
    groupId: uuid("group_id").notNull(),
  },
  (table) => [
    index("pgm_group_id_idx").on(table.groupId),
    index("pgm_person_id_idx").on(table.personId),
  ]
);

// Intelligence Core (ADR-0002) — the family fact base.
//
// Operator-authored (origin='human') and, later, machine-proposed
// (origin='inferred') temporal facts that the date-fusion engine turns into
// evidence: residences, trips, one-off events, recurring events (holidays,
// anniversaries via an rrule string), and life milestones. The two origins are
// a deliberate TIER SEPARATION — only `human` facts/dates ever propagate to a
// neighbouring image's inference (ADR-0003 binding decision).
//
// Dates are partial: `*_date` normalised to first-of-period + a precision tag
// (matches persons.birth_precision). `location_label` is a free-text place the
// operator typed — NOT landmark recognition (absent in Plexo, ADR-0001 D5).
// `person_ids` is a uuid[] of the persons the fact involves (who was on the
// trip). Soft FKs throughout, matching the rest of the schema.
export const temporalFacts = fontoSchema.table(
  "temporal_facts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // 'residence' | 'trip' | 'event' | 'recurring_event' | 'life_milestone'
    // (CHECK in 0043).
    type: text("type").notNull(),
    label: text("label").notNull(),
    dateStart: date("date_start"),
    dateStartPrecision: text("date_start_precision"), // year|month|day
    dateEnd: date("date_end"),
    dateEndPrecision: text("date_end_precision"), // year|month|day
    // iCalendar RRULE string for recurring_event (e.g.
    // 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25'). NULL for one-off facts.
    // Only the YEARLY subset is expanded today (lib/temporal/recurrence.ts).
    recurrence: text("recurrence"),
    locationLabel: text("location_label"),
    personIds: uuid("person_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // Confidence in the fact itself. human facts default 1.0; inferred facts
    // carry the engine's confidence. Fusion multiplies evidence weight by this.
    confidence: real("confidence").notNull().default(1),
    // Tier gate: 'human' | 'inferred' (CHECK in 0043). human-only propagation.
    origin: text("origin").notNull().default("human"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // List/author facts for a workspace, newest first.
    index("temporal_facts_workspace_idx").on(table.workspaceId, table.type),
    // Re-audit (ADR-0006): when a person's facts change, find every fact that
    // names them. GIN over the uuid[] keeps the `person_ids @> ARRAY[...]`
    // membership probe cheap.
    index("temporal_facts_person_ids_idx").using("gin", table.personIds),
  ]
);

// Intelligence Core (ADR-0002 / migration 0044) — the APPEND-ONLY evidence
// ledger. Each row is one dated signal an extractor (Phase 3) pulled from an
// asset: an identity bound, a scene-season hint, a parsed OCR date, the EXIF
// capture stamp, a filename date, the fs-mtime floor, etc.
//
// Append-only: there is no UPDATE. When a producing model improves, the
// extractor writes a NEW row with a newer `model_version`; the fusion engine
// (Phase 4) filters to the current (evidence_type, model_version) per asset and
// ignores the superseded rows (ADR-0006). `likelihood` is RESERVED and left NULL
// in Phase 3 — the per-evidence monthly-grid likelihood vector is a property of
// the fusion contract (ADR-0003), computed + cached by the Phase 4 engine from
// `source_detail`, never by the extractor.
//
// `apparent_age` is a valid evidence_type with no producer in v1 (ADR-0001 D4).
export const imageDateEvidence = fontoSchema.table(
  "image_date_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull(),
    // identity_bound | apparent_age | trip_match | scene_season | ocr_date |
    // exif | filename | fs_mtime | cluster_propagation | co_occurrence
    // (CHECK in 0044).
    evidenceType: text("evidence_type").notNull(),
    // Reserved sparse monthly-grid distribution (ADR-0003). NULL until fusion.
    likelihood: jsonb("likelihood"),
    // The structured raw signal the adapter extracted; the Phase 4 likelihood
    // fns read this. Shape is per evidence_type (see lib/evidence/adapters/*).
    sourceDetail: jsonb("source_detail").notNull(),
    // Producing model/rule version. Perception-backed types carry the Plexo
    // model id; Fonto-local rules carry a rule version string ("exif@1").
    modelVersion: text("model_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Fusion reads every current row for an asset; re-audit re-extracts one type.
    index("image_date_evidence_asset_type_idx").on(
      table.assetId,
      table.evidenceType
    ),
    // Idempotent-replace probe used by the extractor before re-inserting a type
    // at the same model_version.
    index("image_date_evidence_asset_type_version_idx").on(
      table.assetId,
      table.evidenceType,
      table.modelVersion
    ),
  ]
);

// Intelligence Core (ADR-0002 / migration 0044) — near-duplicate candidate
// clusters seeded from existing pHash + CLIP neighbours (Phase 3). Phase 3 only
// writes status='candidate'; the destructive consolidation (deterministic
// canonical pick + sole-copy-safe purge, ADR-0004) is Phase 5 and operator-gated.
//
// Membership lives on `assets.variant_group_id` (soft FK, matching the rest of
// the schema). `canonicalAssetId` stays NULL while 'candidate'.
export const variantGroups = fontoSchema.table(
  "variant_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Stable representative key (seed pHash hex / smallest member id). Diagnostic.
    perceptualKey: text("perceptual_key"),
    // The chosen survivor (Phase 5). NULL while 'candidate'. Soft FK to assets.id.
    canonicalAssetId: uuid("canonical_asset_id"),
    // Tightest pairwise similarity binding the group (0..1) — drives the Phase 5
    // review-vs-auto gate.
    groupingConfidence: real("grouping_confidence"),
    // 'candidate' | 'confirmed' | 'consolidated' (CHECK in 0044).
    status: text("status").notNull().default("candidate"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("variant_groups_workspace_status_idx").on(
      table.workspaceId,
      table.status
    ),
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

// Phase 7a — asset comments + threading.
//
// One row per posted comment. `parent_id` is a self-FK (soft) — NULL for a
// top-level comment, otherwise points at the parent. We allow arbitrary
// depth at the schema level; the UI flattens replies to a single nested
// level (Immich parity) but a future "show full thread" toggle stays
// schema-compatible.
//
// Soft-delete via `deleted_at`: a deleted comment keeps its row so child
// replies don't orphan. The UI renders deleted bodies as "[deleted]";
// the API zeroes the body string on read.
//
// Authorship is by Better Auth `user.id` (text, cross-schema soft FK —
// matches the audit_log + workspace_memberships convention).
export const comments = fontoSchema.table(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    userId: text("user_id").notNull(),
    body: text("body").notNull(),
    parentId: uuid("parent_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Hot path: GET /api/v1/assets/:id/comments — fetch the full thread
    // oldest-first so the UI can build the parent→reply tree in one pass.
    index("comments_asset_created_idx").on(table.assetId, table.createdAt),
    // Workspace-scoped digest aggregation: "all comments in workspace X
    // since timestamp T".
    index("comments_workspace_created_idx").on(table.workspaceId, table.createdAt),
    // Threading lookup: "every reply to comment X".
    index("comments_parent_idx").on(table.parentId),
  ]
);

// Phase 7a — workspace activity feed.
//
// The union of "things worth telling workspace members about" — comment
// posts, asset uploads, member joins, future share events. Surfaces in
// /app/activity (cursor-paginated, newest-first) and feeds the daily
// digest worker.
//
// `kind` is open-vocab (no CHECK constraint) so new event types land
// without a migration. Current emitters:
//   - 'comment.posted'  — POST /api/v1/assets/:id/comments
//   - 'comment.deleted' — DELETE .../comments/:commentId
//   - 'asset.uploaded'  — createAssetRow (Phase 7a hook)
//   - 'asset.shared'    — POST /api/v1/assets/:id/share/workspaces (target ws)
// Future kinds (member.joined) land the same way.
//
// `payload` carries event-specific detail (comment body excerpt, asset
// filename, etc.). Schema is per-kind by convention; the digest renderer
// switches on `kind` to format each entry.
export const activityEvents = fontoSchema.table(
  "activity_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Better Auth user.id of the actor. NULL = system-generated event.
    actorUserId: text("actor_user_id"),
    kind: text("kind").notNull(),
    targetType: text("target_type"),
    // Soft FK to whatever `target_type` names (asset, comment, member…).
    // We keep this as uuid since every current target has a uuid id; if a
    // future target uses a text id, switch to text + a `target_text_id`
    // sibling column rather than coerce.
    targetId: uuid("target_id"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Hot path: /app/activity — paginate workspace events newest-first.
    index("activity_events_workspace_created_idx").on(
      table.workspaceId,
      sql`${table.createdAt} desc`
    ),
    // Digest job — "events newer than my last digest cursor".
    index("activity_events_created_idx").on(table.createdAt),
  ]
);

// Phase 7a — per-user notification mutes.
//
// Granular opt-OUT signal for the daily digest (and future realtime
// channels). Per ADR 0003 the default is digest-on; absence of a row
// here means "follow workspace default".
//
//   scope_type = 'asset'     — mute notifications for activity on a
//                              specific asset (the "per-share mute" the
//                              7a checklist calls out).
//   scope_type = 'workspace' — mute the entire workspace's digest for
//                              this user. `scope_id` MUST equal
//                              `workspace_id` (enforced by CHECK in 0027
//                              so the row stays interpretable).
//
// CHECK on scope_type lives in the migration.
export const notificationMutes = fontoSchema.table(
  "notification_mutes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("notification_mutes_user_scope_idx").on(
      table.userId,
      table.workspaceId,
      table.scopeType,
      table.scopeId
    ),
    index("notification_mutes_workspace_idx").on(table.workspaceId),
  ]
);

// Phase 6.4 — per-device FCM push tokens. One row per (user, device).
// `deviceId` is a stable client-generated id so re-registering the same
// device replaces (not duplicates) its token. `platform` ∈ android|ios|web.
export const pushTokens = fontoSchema.table(
  "push_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    token: text("token").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("push_tokens_user_device_idx").on(table.userId, table.deviceId),
    index("push_tokens_user_idx").on(table.userId),
  ]
);

// Phase 7b — cross-workspace asset sharing (reference model, C5).
//
// One row per (sourceWorkspace, asset, targetWorkspace) grant. The
// asset's R2 object is NOT copied — both sides read from the source
// workspace's storage. If the source workspace deletes the asset, the
// share rows are reaped (worker sweep) and the target side loses
// access. This is the deliberate tradeoff per ADR C5: storage-cheap +
// always-fresh.
//
// `accessLevel` mirrors the WorkspaceRole vocabulary but caps at
// 'editor' (a share grant never elevates the recipient above editor on
// the foreign asset — owner/billing concepts don't transfer). Common
// values: 'viewer', 'commenter', 'contributor'. Editor on a shared
// asset means the recipient can also re-share / trash the local
// reference, but NOT delete the underlying R2 object (that stays with
// the source workspace's owner).
//
// `createdBy` is the source-workspace user who issued the share. Used
// for the audit trail + the "shared by @alice" badge in the target
// workspace's grid.
export const sharedAssets = fontoSchema.table(
  "shared_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull(),
    sourceWorkspaceId: uuid("source_workspace_id").notNull(),
    targetWorkspaceId: uuid("target_workspace_id").notNull(),
    accessLevel: text("access_level").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // One active share per (asset, target). Revoking sets revoked_at
    // but keeps the row for audit; re-sharing inserts a new row (the
    // unique index includes revoked_at via expression so revoked rows
    // don't block re-grant).
    uniqueIndex("shared_assets_asset_target_active_idx")
      .on(table.assetId, table.targetWorkspaceId)
      .where(sql`${table.revokedAt} IS NULL`),
    // "What's been shared INTO this workspace?" — the target-side
    // listing query joins assets ON shared_assets.asset_id.
    index("shared_assets_target_idx").on(table.targetWorkspaceId, table.revokedAt),
    // "What's been shared FROM this workspace?" — settings UI for the
    // source workspace to audit outgoing shares.
    index("shared_assets_source_idx").on(table.sourceWorkspaceId, table.revokedAt),
  ]
);

// Phase 7a — digest cursor.
//
// One row per (user, workspace) once the user has been issued at least
// one digest. Records the `created_at` of the newest activity_event the
// last digest covered. On the next tick, the worker pulls events with
// `created_at > cursor` and (if any are unmuted + visible) sends an
// email + advances the cursor.
//
// Absence of a row means "never digested" — the worker treats this as
// "send the past 24h then write a cursor", so a brand-new member doesn't
// receive a backfill of every event since workspace creation.
export const digestCursors = fontoSchema.table(
  "digest_cursors",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("digest_cursors_user_workspace_idx").on(
      table.userId,
      table.workspaceId
    ),
  ]
);

// Phase 0 (media import) — third-party OAuth integrations. One row per
// (workspace, user, provider) connection; currently only Google (Drive
// readonly for Takeout archives). The refresh token is encrypted at rest
// (the encryption is applied by the OAuth callback in Phase 1, never stored
// plaintext). `status` tracks the connection health:
//   - 'active'          — usable; refresh token mints access tokens
//   - 'needs_reconnect' — refresh returned invalid_grant (revoked / 7-day
//                         Testing-app expiry); surface a reconnect CTA
//   - 'revoked'         — user disconnected; revokedAt set
export const integrations = fontoSchema.table(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Matches Better Auth `user.id` (text). Cross-schema; FK enforced in SQL.
    userId: text("user_id").notNull(),
    // 'google' (only provider for now). Kept as text for forward extension.
    provider: text("provider").notNull(),
    // Encrypted refresh token (never plaintext). NULL until the OAuth
    // callback completes a successful code exchange.
    encryptedRefreshToken: text("encrypted_refresh_token"),
    // Space- or comma-delimited list of scopes Google actually granted, as
    // returned by the token response (may differ from what we requested).
    grantedScopes: text("granted_scopes"),
    // 'active' | 'needs_reconnect' | 'revoked' — CHECK constraint in SQL.
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Set when the user disconnects (status → 'revoked'); NULL while connected.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // "Which integration backs this user's Google import?" — the lookup the
    // OAuth callback (upsert) and the import job (token refresh) both hit.
    index("integrations_workspace_user_provider_idx").on(
      table.workspaceId,
      table.userId,
      table.provider
    ),
  ]
);

// Phase 0 (media import) — per-import progress + resume state. One row per
// kicked-off import; the BullMQ `media-import` job updates its counts in
// batches (every ~25 items, per ADR C5) and the web UI polls it. `cursor` is
// an opaque, provider-specific resume marker (e.g. the last-processed archive
// member) so a worker restart resumes instead of re-ingesting from zero.
export const importJobs = fontoSchema.table(
  "import_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // Matches Better Auth `user.id` (text). Cross-schema; FK enforced in SQL.
    userId: text("user_id").notNull(),
    // 'google-takeout' | 'amazon-photos' — CHECK constraint in SQL.
    provider: text("provider").notNull(),
    // 'pending' | 'running' | 'completed' | 'failed' — CHECK in SQL.
    status: text("status").notNull().default("pending"),
    // Discovered total (0 until the worker has enumerated the archive).
    itemsTotal: integer("items_total").notNull().default(0),
    // Successfully ingested (new asset rows created).
    itemsProcessed: integer("items_processed").notNull().default(0),
    // Skipped because createAssetRow found an existing SHA-256 match.
    itemsDeduped: integer("items_deduped").notNull().default(0),
    // Members that errored (counted + logged; the job continues).
    itemsFailed: integer("items_failed").notNull().default(0),
    // Opaque provider-specific resume marker; NULL at start.
    cursor: text("cursor"),
    // Terminal error message when status='failed'; NULL otherwise.
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // "List this workspace's active/recent imports" — the progress page query.
    index("import_jobs_workspace_status_idx").on(table.workspaceId, table.status),
  ]
);
