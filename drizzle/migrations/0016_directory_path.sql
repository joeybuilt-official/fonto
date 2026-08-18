-- SPDX-License-Identifier: MIT
-- Phase 3.5: virtual folder view.
--
-- Adds a `directory_path` column to `fonto.assets` so uploads can carry the
-- source directory tree (Immich-style folder view). Folders are virtual —
-- there is no `folders` table — they're computed at read time by GROUP BY-ing
-- prefixes of `directory_path`. The companion `(workspace_id, directory_path)`
-- index makes the prefix scan cheap.
--
-- Also adds a `directory_path` slot to `fonto.asset_uploads` so the presigned
-- two-step flow (POST /init -> PUT to R2 -> POST /complete) can persist the
-- path between init and complete; the column is copied into the assets row
-- when /complete fires.
--
-- Both changes are additive (ADD COLUMN IF NOT EXISTS) — safe to apply on any
-- environment running migrations 0001..0015.

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS directory_path text;

ALTER TABLE fonto.asset_uploads
    ADD COLUMN IF NOT EXISTS directory_path text;

CREATE INDEX IF NOT EXISTS assets_workspace_directory_path_idx
    ON fonto.assets (workspace_id, directory_path);
