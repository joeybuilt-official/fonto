-- SPDX-License-Identifier: MIT
-- Phase 3.1 — workspace_memberships (see ADR 0004).
--
-- Today, workspaces are single-owner: `fonto.workspaces.user_id` is the de
-- facto owner column. This migration introduces the membership table that
-- replaces it as the authoritative source for cross-user access.
--
-- The workspaces.user_id column is intentionally kept for one release as the
-- canonical "personal-owner pointer" so any code that hasn't been migrated to
-- assertWorkspaceAccess yet keeps working. Phase 3.2+ may drop it.

-- ── Table ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.workspace_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES fonto.workspaces(id) ON DELETE CASCADE,
  -- Matches Better Auth `auth.user.id` (text). The cross-schema FK is intentionally
  -- omitted (drizzle doesn't see the auth schema during planning); the application
  -- layer enforces existence via assertWorkspaceAccess + getAuthUser.
  user_id      text NOT NULL,
  role         text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Inviter's user id; NULL for backfilled owners.
  created_by   text,
  UNIQUE (workspace_id, user_id)
);

-- ── Backfill: one owner membership per existing workspace ─────────────────
-- Idempotent — ON CONFLICT lets re-runs no-op (and lets parallel Phase 3
-- migrations that reference this table run before 0012 if needed).
INSERT INTO fonto.workspace_memberships (workspace_id, user_id, role, created_by)
SELECT id, user_id, 'owner', NULL
  FROM fonto.workspaces
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- "What workspaces can this user see?" (hot path: getUserWorkspaces).
CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx
  ON fonto.workspace_memberships (user_id);

-- "Who's an editor in this workspace?" (member list + invite queries).
CREATE INDEX IF NOT EXISTS workspace_memberships_workspace_role_idx
  ON fonto.workspace_memberships (workspace_id, role);
