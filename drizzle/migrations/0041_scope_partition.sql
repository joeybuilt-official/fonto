-- ADR 0008 — scope partition: PERSONAL vs SHOOT.
-- Adds an authoritative single-valued `scope` to assets that drives default
-- behavior (timeline / On This Day / search default to PERSONAL), plus the
-- SHOOT organization tables (clients, shoots) and a reversible reassignment
-- ledger. Idempotent. Head before this = 0040_storage_placement.
--
-- Locking note (PG11+): ADD COLUMN ... NOT NULL DEFAULT does NOT rewrite the
-- table — the default is stored in the catalog and read for existing rows.
-- Safe on the live assets table without a maintenance window.

-- ── assets: scope / shoot membership ────────────────────────────────────────
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'PERSONAL';
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS shoot_id uuid;          -- soft FK -> fonto.shoots
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS shoot_stage text;       -- RAW|SELECTS|DELIVERED|REJECTS

DO $$ BEGIN
  ALTER TABLE fonto.assets
    ADD CONSTRAINT assets_scope_check CHECK (scope IN ('PERSONAL', 'SHOOT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.assets
    ADD CONSTRAINT assets_shoot_stage_check
    CHECK (shoot_stage IS NULL OR shoot_stage IN ('RAW', 'SELECTS', 'DELIVERED', 'REJECTS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Default feed + SHOOT browser: (workspace, scope, captured_at desc).
CREATE INDEX IF NOT EXISTS assets_workspace_scope_captured_idx
    ON fonto.assets (workspace_id, scope, captured_at DESC);

-- Shoot membership scans, partial on filed assets.
CREATE INDEX IF NOT EXISTS assets_shoot_id_idx
    ON fonto.assets (shoot_id)
    WHERE shoot_id IS NOT NULL;

-- Memories ("On This Day") only ever serves PERSONAL. Specialised partial
-- index alongside the 0023 index (which is kept for scope-agnostic callers).
CREATE INDEX IF NOT EXISTS assets_workspace_captured_mmdd_personal_idx
    ON fonto.assets (
        workspace_id,
        fonto.captured_mmdd_utc(captured_at)
    )
    WHERE lifecycle_state = 'active' AND captured_at IS NOT NULL AND scope = 'PERSONAL';

-- ── clients (optional shoot parent) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.clients (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    user_id     text NOT NULL,
    name        text NOT NULL,
    notes       text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    seq         bigint
);
CREATE INDEX IF NOT EXISTS clients_workspace_id_idx ON fonto.clients (workspace_id);
CREATE INDEX IF NOT EXISTS clients_workspace_seq_idx ON fonto.clients (workspace_id, seq);

-- ── shoots (the session) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.shoots (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL,
    user_id       text NOT NULL,
    client_id     uuid,                 -- soft FK -> fonto.clients; NULL = hobby
    name          text NOT NULL,
    shoot_date    date,
    kind          text,
    paid          boolean NOT NULL DEFAULT false,
    consent_status text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    seq           bigint
);
CREATE INDEX IF NOT EXISTS shoots_workspace_id_idx ON fonto.shoots (workspace_id);
CREATE INDEX IF NOT EXISTS shoots_client_id_idx ON fonto.shoots (client_id);
CREATE INDEX IF NOT EXISTS shoots_workspace_seq_idx ON fonto.shoots (workspace_id, seq);

-- ── scope_reassignments (reversible ledger) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.scope_reassignments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL,
    asset_id      uuid NOT NULL,
    batch_id      uuid NOT NULL,
    from_scope    text NOT NULL,
    to_scope      text NOT NULL,
    from_shoot_id uuid,
    to_shoot_id   uuid,
    actor         text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- Idempotent batch re-runs: one ledger row per (asset, batch).
CREATE UNIQUE INDEX IF NOT EXISTS scope_reassignments_asset_batch_idx
    ON fonto.scope_reassignments (asset_id, batch_id);
CREATE INDEX IF NOT EXISTS scope_reassignments_batch_idx
    ON fonto.scope_reassignments (batch_id);
CREATE INDEX IF NOT EXISTS scope_reassignments_workspace_idx
    ON fonto.scope_reassignments (workspace_id);
