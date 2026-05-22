-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 1.4: resumable/chunked uploads via tus.
--
-- Tracks tus uploads from creation through completion so the upload can be
-- resumed across client reconnects and reconciled with the eventual asset
-- row materialized in `onUploadFinish`. This table is intentionally minimal
-- and will be collapsed into Phase 1.2's `asset_uploads` by the integration
-- agent (column names here mirror what Phase 1.2 is expected to use).

CREATE TABLE IF NOT EXISTS fonto.tus_uploads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id     text NOT NULL,
    user_id       text NOT NULL,
    workspace_id  uuid NOT NULL,
    filename      text NOT NULL,
    mime_type     text NOT NULL,
    size_bytes    bigint,
    state         text NOT NULL DEFAULT 'open',
    asset_id      uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS tus_uploads_upload_id_idx
    ON fonto.tus_uploads (upload_id);
CREATE INDEX IF NOT EXISTS tus_uploads_user_id_idx
    ON fonto.tus_uploads (user_id);
CREATE INDEX IF NOT EXISTS tus_uploads_workspace_id_idx
    ON fonto.tus_uploads (workspace_id);
