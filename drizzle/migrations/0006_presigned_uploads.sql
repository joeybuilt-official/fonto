-- SPDX-License-Identifier: MIT
-- Phase 1.2 (Fonto → Immich parity): presigned direct-to-R2 PUT uploads.
--
-- Tracks two-step uploads driven by POST /api/v1/assets/init +
-- POST /api/v1/assets/:id/complete. Distinct from fonto.upload_sessions —
-- that table is idempotency state for the legacy multipart POST; this one
-- is the state machine for the new direct-to-R2 flow.
--
-- Numbering note: phase 1.1 (thumbnails) is taking 0005_*. This migration
-- takes 0006_ so the two land independently.

CREATE TABLE IF NOT EXISTS fonto.asset_uploads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL,
  user_id               text NOT NULL,
  filename              text NOT NULL,
  mime_type             text NOT NULL,
  size_bytes            bigint NOT NULL,
  client_checksum       text,
  storage_key           text NOT NULL,
  state                 text NOT NULL DEFAULT 'pending',
  presigned_expires_at  timestamptz NOT NULL,
  asset_id              uuid REFERENCES fonto.assets(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_uploads_workspace_state_idx
  ON fonto.asset_uploads (workspace_id, state);

CREATE INDEX IF NOT EXISTS asset_uploads_user_state_idx
  ON fonto.asset_uploads (user_id, state);
