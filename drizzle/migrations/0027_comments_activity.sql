-- SPDX-License-Identifier: MIT
-- Phase 7a — comments, activity feed, notification mutes, digest cursors.
--
-- Four new tables under fonto.* schema. All workspace-scoped + indexed on
-- the workspace_id leading column so per-workspace queries are index-driven.
--
-- See lib/db/schema.ts for the full table comments + design rationale.
--
-- CHECK constraints land here (Drizzle doesn't model them at TS level).
-- Foreign keys are SOFT (matches the rest of the schema — see assets,
-- workspace_memberships) so the application owns referential lifecycle.

-- ─────────────────────────────────────────────────────────────────────────
-- comments
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE fonto.comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  asset_id     UUID NOT NULL,
  user_id      TEXT NOT NULL,
  body         TEXT NOT NULL,
  parent_id    UUID,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Body length cap: matches Immich (10 KB) and keeps the GIN/btree row
-- size honest. Empty bodies are rejected — a deleted comment uses
-- `deleted_at` rather than blanking `body`.
ALTER TABLE fonto.comments
  ADD CONSTRAINT comments_body_length_chk
  CHECK (length(body) > 0 AND length(body) <= 10240);

-- Hot path: GET /api/v1/assets/:id/comments — fetch the full thread
-- oldest-first so the UI builds the parent→reply tree in one pass.
CREATE INDEX comments_asset_created_idx
  ON fonto.comments (asset_id, created_at);

-- Workspace-scoped digest aggregation.
CREATE INDEX comments_workspace_created_idx
  ON fonto.comments (workspace_id, created_at);

-- "Every reply to comment X" — threading lookup.
CREATE INDEX comments_parent_idx
  ON fonto.comments (parent_id);

-- ─────────────────────────────────────────────────────────────────────────
-- activity_events
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE fonto.activity_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL,
  actor_user_id  TEXT,
  kind           TEXT NOT NULL,
  target_type    TEXT,
  target_id      UUID,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kind is open-vocab (no CHECK) — new event types land without a
-- migration. See lib/db/schema.ts for the current canonical list.

-- Hot path: /app/activity newest-first pagination.
CREATE INDEX activity_events_workspace_created_idx
  ON fonto.activity_events (workspace_id, created_at DESC);

-- Digest job — events newer than the last digest cursor.
CREATE INDEX activity_events_created_idx
  ON fonto.activity_events (created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- notification_mutes
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE fonto.notification_mutes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  scope_type   TEXT NOT NULL,
  scope_id     UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scope vocabulary — keep tight; new scopes need a migration so the
-- digest worker can grow logic to honour them deliberately.
ALTER TABLE fonto.notification_mutes
  ADD CONSTRAINT notification_mutes_scope_type_chk
  CHECK (scope_type IN ('asset', 'workspace'));

-- Workspace-scope mute must point at the row's own workspace_id (keeps
-- the row interpretable without joining anything).
ALTER TABLE fonto.notification_mutes
  ADD CONSTRAINT notification_mutes_workspace_scope_chk
  CHECK (scope_type <> 'workspace' OR scope_id = workspace_id);

-- One mute per (user, workspace, scope) — toggling on/off is an
-- INSERT … ON CONFLICT DO NOTHING + DELETE pair.
CREATE UNIQUE INDEX notification_mutes_user_scope_idx
  ON fonto.notification_mutes (user_id, workspace_id, scope_type, scope_id);

CREATE INDEX notification_mutes_workspace_idx
  ON fonto.notification_mutes (workspace_id);

-- ─────────────────────────────────────────────────────────────────────────
-- digest_cursors
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE fonto.digest_cursors (
  workspace_id  UUID NOT NULL,
  user_id       TEXT NOT NULL,
  last_event_at TIMESTAMPTZ NOT NULL,
  last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX digest_cursors_user_workspace_idx
  ON fonto.digest_cursors (user_id, workspace_id);
