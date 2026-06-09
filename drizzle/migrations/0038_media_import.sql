-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0038: media import (Phase 0) — Google Takeout + Amazon Photos.
--
-- Two additive tables and one partial unique index on the existing `assets`
-- table. The tables are pure additions (no existing schema changes), so the
-- DDL up to the index is safe to apply inside the single-transaction runner
-- this repo uses (see next-session-deploy.md: "Drizzle has no journal — raw
-- psql + single tx").
--
-- `integrations` holds third-party OAuth connections (only Google for now;
-- the refresh token is stored encrypted by the Phase 1 OAuth callback, never
-- plaintext). `import_jobs` is the per-import progress + resume row the
-- `media-import` BullMQ worker updates in batches and the web UI polls.

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

-- =====================================================================
-- Partial unique index on assets(workspace_id, sha256) WHERE active (ADR C4).
--
-- Closes the dedup race: two concurrent import workers can otherwise insert
-- the same SHA-256 before either sees the other's row. The partial predicate
-- (lifecycle_state = 'active') also keeps the index small and speeds the
-- dedup SELECT in createAssetRow.
--
-- ⚠⚠⚠ DUPLICATE PRE-CHECK REQUIRED BEFORE THIS WILL APPLY ⚠⚠⚠
-- This index FAILS to build if the target DB already has two or more active
-- rows sharing a (workspace_id, sha256) pair. The fonto library predates any
-- unique constraint, so such duplicates may exist. Before applying 0038 on a
-- populated DB (prod, dev) you MUST run the dedup pre-pass first:
--
--   SELECT workspace_id, sha256, count(*)
--   FROM fonto.assets
--   WHERE lifecycle_state = 'active'
--   GROUP BY workspace_id, sha256
--   HAVING count(*) > 1;
--
-- If that returns any rows, soft-delete (lifecycle_state <> 'active') all but
-- one of each group — keeping the canonical row — BEFORE this index is built.
-- That dedup is deliberately NOT performed in this migration: it touches user
-- data and must be reviewed per-environment (which row survives, what happens
-- to collection/tag/share references on the losers). Do it as a separate,
-- audited step.
--
-- ── Transaction tradeoff ──
-- CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a transaction block, and
-- this repo's migration runner wraps each migration in a single tx
-- (next-session-deploy.md). A CONCURRENTLY statement here would error with
-- "CREATE INDEX CONCURRENTLY cannot run inside a transaction block". We
-- therefore use a plain (locking) CREATE UNIQUE INDEX. Tradeoff: building it
-- takes an ACCESS EXCLUSIVE-ish share lock that blocks writes to `assets` for
-- the build duration. On the fonto library (~10.5k assets) this is brief
-- (sub-second to low seconds). If applied against a much larger table, run
-- this single statement out-of-band, OUTSIDE the tx wrapper, as:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     assets_workspace_sha256_active_uidx
--     ON fonto.assets (workspace_id, sha256)
--     WHERE lifecycle_state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS assets_workspace_sha256_active_uidx
    ON fonto.assets (workspace_id, sha256)
    WHERE lifecycle_state = 'active';
