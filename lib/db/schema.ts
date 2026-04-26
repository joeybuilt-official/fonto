import {
  pgSchema,
  uuid,
  text,
  bigint,
  timestamp,
  index,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workspaces_user_id_idx").on(table.userId),
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
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("assets_workspace_id_idx").on(table.workspaceId),
    index("assets_mime_type_idx").on(table.mimeType),
    index("assets_lifecycle_state_idx").on(table.lifecycleState),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("collections_workspace_id_idx").on(table.workspaceId),
  ]
);

export const collectionAssets = fontoSchema.table(
  "collection_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("collection_assets_collection_id_idx").on(table.collectionId),
    index("collection_assets_asset_id_idx").on(table.assetId),
  ]
);
