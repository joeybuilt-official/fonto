-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 3.3 — workspace invitations.
--
-- Email-keyed invitations that produce `workspace_memberships` rows on
-- acceptance. See ADR 0004 for the full multi-user model. The companion
-- `workspace_memberships` table is added in Phase 3.1 (migration 0012).
--
-- Token storage: PLAINTEXT random 32-byte URL-safe value (unlike PATs in
-- 0008 which are hashed). Invitations are short-lived (7 days) and have
-- a single acceptable use — the attack surface is much smaller, and
-- storing plaintext lets the settings UI re-show the URL when a
-- recipient loses the original email.

CREATE TABLE IF NOT EXISTS fonto.workspace_invitations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         uuid NOT NULL,
    -- Lowercased on insert. Comparisons are case-insensitive in app code.
    email                text NOT NULL,
    -- 'editor' | 'viewer'. Owners cannot be invited; they're minted at
    -- workspace creation. Promotion to owner is a membership update.
    role                 text NOT NULL CHECK (role IN ('editor', 'viewer')),
    token                text NOT NULL,
    -- Better Auth `user.id` of the inviter (text — auth schema uses text PKs).
    invited_by           text NOT NULL,
    accepted_at          timestamptz,
    accepted_by_user_id  text,
    revoked_at           timestamptz,
    -- Default 7 days from create; computed in app code so we can honour
    -- `WORKSPACE_INVITATION_TTL_DAYS`.
    expires_at           timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);

-- Token is the lookup key for `/api/v1/workspace/invitations/:token`.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_token_idx
    ON fonto.workspace_invitations (token);

-- "Pending invitations in this workspace" — the settings members page
-- filters on (workspaceId, acceptedAt IS NULL, revokedAt IS NULL,
-- expiresAt > now()).
CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_state_idx
    ON fonto.workspace_invitations (workspace_id, accepted_at, revoked_at, expires_at);

-- "All invitations addressed to <email>" — surfaced after a new user
-- completes signup with `?invitation=<token>`.
CREATE INDEX IF NOT EXISTS workspace_invitations_email_idx
    ON fonto.workspace_invitations (email);
