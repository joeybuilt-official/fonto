-- SPDX-License-Identifier: MIT
-- Migration 0038: media import (Phase 0) — Google Takeout + Amazon Photos.
--
-- Two additive tables, no changes to existing schema, safe in the
-- single-transaction runner this repo uses (raw psql, no journal).
--
-- `integrations` holds third-party OAuth connections (only Google for now; the
-- refresh token is stored encrypted by the OAuth callback / mobile-connect
-- route, never plaintext). `import_jobs` is the per-import progress + resume row
-- the `media-import` BullMQ worker updates in batches and the UI polls.
--
-- NOTE: the partial unique index on assets(workspace_id, sha256) lives in the
-- SEPARATE migration 0039_assets_sha256_unique.sql — it requires a duplicate
-- dedup pre-pass first (prod had 1078 active dup rows on 2026-06-09) and is NOT
-- required for the feature to work (createAssetRow already SELECT-dedups).

CREATE TABLE IF NOT EXISTS fonto.integrations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id             uuid NOT NULL,
    user_id                  text NOT NULL,
    provider                 text NOT NULL,
    encrypted_refresh_token  text,
    granted_scopes           text,
    status                   text NOT NULL DEFAULT 'active',
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    revoked_at               timestamptz,
    CONSTRAINT integrations_provider_check
        CHECK (provider IN ('google')),
    CONSTRAINT integrations_status_check
        CHECK (status IN ('active', 'needs_reconnect', 'revoked'))
);

CREATE INDEX IF NOT EXISTS integrations_workspace_user_provider_idx
    ON fonto.integrations (workspace_id, user_id, provider);

CREATE TABLE IF NOT EXISTS fonto.import_jobs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     uuid NOT NULL,
    user_id          text NOT NULL,
    provider         text NOT NULL,
    status           text NOT NULL DEFAULT 'pending',
    items_total      integer NOT NULL DEFAULT 0,
    items_processed  integer NOT NULL DEFAULT 0,
    items_deduped    integer NOT NULL DEFAULT 0,
    items_failed     integer NOT NULL DEFAULT 0,
    cursor           text,
    error            text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT import_jobs_provider_check
        CHECK (provider IN ('google-takeout', 'amazon-photos')),
    CONSTRAINT import_jobs_status_check
        CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS import_jobs_workspace_status_idx
    ON fonto.import_jobs (workspace_id, status);
