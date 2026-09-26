-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- 0000 — FONTO SCHEMA BASELINE.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `drizzle/migrations/` starts at 0001_share_links.sql, and 0002 immediately
-- does `ALTER TABLE fonto.assets`. Nothing in the numbered series ever CREATES
-- `fonto.assets`, `fonto.workspaces`, `fonto.collections`, `fonto.tags`,
-- `fonto.asset_tags`, `fonto.upload_sessions`, `fonto.smart_collections`,
-- `fonto.projects`, `fonto.correspondents`, `fonto.document_types` or
-- `fonto.collection_assets`. Those eleven tables were created out-of-band
-- (drizzle-kit push against the developer database) before the numbered series
-- began, so on a fresh database the series cannot even start: 0002 fails with
-- `relation "fonto.assets" does not exist`.
--
-- This baseline closes that gap. It is the DDL for the eleven tables as they
-- existed at commit a57c2b3^ (2026-04-27, "feat(phase-5f): organization +
-- discovery") — i.e. the exact schema state immediately BEFORE
-- 0001_share_links.sql was added. It was generated with:
--
--     git show a57c2b3^:lib/db/schema.ts > lib/db/_baseline_tmp.ts
--     drizzle-kit generate --config <out=/tmp> --schema lib/db/_baseline_tmp.ts
--
-- then cleaned up: `CREATE SCHEMA`/`CREATE TABLE`/`CREATE INDEX` made
-- `IF NOT EXISTS`, drizzle's `--> statement-breakpoint` markers removed (this
-- file is applied by scripts/db-apply.sh via psql, not by the drizzle
-- migrator), and the `vector` type kept out — pgvector is enabled by migration
-- 0017, which is where the first vector column belongs.
--
-- Idempotent: every object is IF NOT EXISTS-guarded, so re-running is a no-op.
--
-- If you are adopting an ALREADY-MIGRATED database, do not run this by hand —
-- use `scripts/db-apply.sh --adopt` (see that script's header).

CREATE SCHEMA IF NOT EXISTS fonto;

CREATE TABLE IF NOT EXISTS fonto.workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id     text NOT NULL,
  name        text NOT NULL,
  slug        text NOT NULL,
  kind        text DEFAULT 'personal' NOT NULL,
  color       text DEFAULT '#6366f1' NOT NULL,
  created_at  timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_user_id_idx ON fonto.workspaces USING btree (user_id);

CREATE TABLE IF NOT EXISTS fonto.assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id       uuid NOT NULL,
  filename           text NOT NULL,
  mime_type          text NOT NULL,
  size_bytes         bigint NOT NULL,
  sha256             text NOT NULL,
  sync_state         text DEFAULT 'synced' NOT NULL,
  processing_state   text DEFAULT 'captured' NOT NULL,
  lifecycle_state    text DEFAULT 'active' NOT NULL,
  source             text,
  classification     text,
  description        text,
  extracted_text     text,
  correspondent_id   uuid,
  document_type_id   uuid,
  captured_at        timestamp with time zone,
  deleted_at         timestamp with time zone,
  archived_at        timestamp with time zone,
  purged_at          timestamp with time zone,
  created_at         timestamp with time zone DEFAULT now() NOT NULL,
  updated_at         timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_workspace_id_idx     ON fonto.assets USING btree (workspace_id);
CREATE INDEX IF NOT EXISTS assets_mime_type_idx        ON fonto.assets USING btree (mime_type);
CREATE INDEX IF NOT EXISTS assets_lifecycle_state_idx  ON fonto.assets USING btree (lifecycle_state);
CREATE INDEX IF NOT EXISTS assets_processing_state_idx ON fonto.assets USING btree (processing_state);

CREATE TABLE IF NOT EXISTS fonto.collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  user_id     text NOT NULL,
  name        text NOT NULL,
  description text DEFAULT '' NOT NULL,
  project_id  uuid,
  sort_order  integer DEFAULT 0 NOT NULL,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  updated_at  timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS collections_workspace_id_idx ON fonto.collections USING btree (workspace_id);
CREATE INDEX IF NOT EXISTS collections_project_id_idx   ON fonto.collections USING btree (project_id);

CREATE TABLE IF NOT EXISTS fonto.collection_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  collection_id uuid NOT NULL,
  asset_id      uuid NOT NULL,
  added_at      timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS collection_assets_collection_id_idx ON fonto.collection_assets USING btree (collection_id);
CREATE INDEX IF NOT EXISTS collection_assets_asset_id_idx      ON fonto.collection_assets USING btree (asset_id);

CREATE TABLE IF NOT EXISTS fonto.tags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  name         text NOT NULL,
  color        text DEFAULT '#6366f1' NOT NULL,
  ai_suggested boolean DEFAULT false NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS tags_workspace_id_idx ON fonto.tags USING btree (workspace_id);

CREATE TABLE IF NOT EXISTS fonto.asset_tags (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  asset_id uuid NOT NULL,
  tag_id   uuid NOT NULL,
  added_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_tags_asset_id_idx ON fonto.asset_tags USING btree (asset_id);
CREATE INDEX IF NOT EXISTS asset_tags_tag_id_idx   ON fonto.asset_tags USING btree (tag_id);

CREATE TABLE IF NOT EXISTS fonto.upload_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  upload_id    text NOT NULL,
  user_id      text NOT NULL,
  workspace_id uuid NOT NULL,
  asset_id     uuid,
  state        text DEFAULT 'open' NOT NULL,
  expires_at   timestamp with time zone NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_upload_id_idx ON fonto.upload_sessions USING btree (upload_id);
CREATE INDEX IF NOT EXISTS upload_sessions_user_id_idx          ON fonto.upload_sessions USING btree (user_id);

CREATE TABLE IF NOT EXISTS fonto.smart_collections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  user_id      text NOT NULL,
  name         text NOT NULL,
  query        jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS smart_collections_workspace_id_idx ON fonto.smart_collections USING btree (workspace_id);

CREATE TABLE IF NOT EXISTS fonto.projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  user_id      text NOT NULL,
  name         text NOT NULL,
  description  text DEFAULT '' NOT NULL,
  color        text DEFAULT '#6366f1' NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_workspace_id_idx ON fonto.projects USING btree (workspace_id);

CREATE TABLE IF NOT EXISTS fonto.correspondents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id  uuid NOT NULL,
  name          text NOT NULL,
  match_pattern text,
  created_at    timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS correspondents_workspace_id_idx ON fonto.correspondents USING btree (workspace_id);

CREATE TABLE IF NOT EXISTS fonto.document_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id  uuid NOT NULL,
  name          text NOT NULL,
  match_pattern text,
  created_at    timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS document_types_workspace_id_idx ON fonto.document_types USING btree (workspace_id);
