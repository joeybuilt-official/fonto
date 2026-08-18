-- SPDX-License-Identifier: MIT
-- Phase 7b — extended workspace role ladder + cross-workspace sharing.
--
-- 1. Extend the role vocabulary on workspace_memberships and
--    workspace_invitations to include 'commenter' and 'contributor'.
--    Migration 0012 declared an inline CHECK on memberships.role; 0014
--    did the same on invitations.role. Both are unnamed (auto-named by
--    Postgres as <table>_<column>_check). We drop + re-create them
--    explicitly named so future drops are unambiguous.
--
-- 2. Create fonto.shared_assets — the reference-model store backing
--    C5. No R2 duplication: target workspaces see the source row's
--    bytes. See lib/db/schema.ts for the full table comments.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. workspace_memberships.role — extend CHECK
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE fonto.workspace_memberships
  DROP CONSTRAINT IF EXISTS workspace_memberships_role_check;

ALTER TABLE fonto.workspace_memberships
  ADD CONSTRAINT workspace_memberships_role_check
  CHECK (role IN ('owner', 'editor', 'contributor', 'commenter', 'viewer'));

-- ─────────────────────────────────────────────────────────────────────────
-- 1b. workspace_invitations.role — extend CHECK
-- ─────────────────────────────────────────────────────────────────────────
--
-- Original vocab was ('editor', 'viewer'). Expand to allow inviting
-- commenters and contributors directly — that's the whole reason the
-- new ladder exists. Owner still cannot be invited (minted on workspace
-- creation; promote via member-update endpoint).

ALTER TABLE fonto.workspace_invitations
  DROP CONSTRAINT IF EXISTS workspace_invitations_role_check;

ALTER TABLE fonto.workspace_invitations
  ADD CONSTRAINT workspace_invitations_role_check
  CHECK (role IN ('editor', 'contributor', 'commenter', 'viewer'));

-- ─────────────────────────────────────────────────────────────────────────
-- 2. shared_assets
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE fonto.shared_assets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id              UUID NOT NULL,
  source_workspace_id   UUID NOT NULL,
  target_workspace_id   UUID NOT NULL,
  -- One of viewer | commenter | contributor | editor. Owner is NEVER
  -- valid on a shared asset (owner is a workspace-level concept and
  -- the recipient is not in the source workspace).
  access_level          TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ
);

ALTER TABLE fonto.shared_assets
  ADD CONSTRAINT shared_assets_access_level_check
  CHECK (access_level IN ('viewer', 'commenter', 'contributor', 'editor'));

-- Self-share is meaningless and would corrupt the source-vs-target
-- assumptions in every visibility query.
ALTER TABLE fonto.shared_assets
  ADD CONSTRAINT shared_assets_distinct_workspaces_check
  CHECK (source_workspace_id <> target_workspace_id);

-- One ACTIVE share per (asset, target). Revoking sets revoked_at; the
-- partial index ignores revoked rows so re-sharing inserts fresh
-- without colliding on the old row.
CREATE UNIQUE INDEX shared_assets_asset_target_active_idx
  ON fonto.shared_assets (asset_id, target_workspace_id)
  WHERE revoked_at IS NULL;

-- Target-side listing: "what's been shared INTO this workspace?".
-- Joined against fonto.assets ON shared_assets.asset_id when computing
-- the union grid response.
CREATE INDEX shared_assets_target_idx
  ON fonto.shared_assets (target_workspace_id, revoked_at);

-- Source-side audit: "what's been shared FROM this workspace?".
CREATE INDEX shared_assets_source_idx
  ON fonto.shared_assets (source_workspace_id, revoked_at);
