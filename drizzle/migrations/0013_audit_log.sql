-- SPDX-License-Identifier: MIT
-- Phase 3.2: append-only audit log.
--
-- Records every state-mutating action a user performs against a workspace.
-- The log is append-only at the application layer; rows only ever leave the
-- table via the BullMQ retention reaper (default 90d, AUDIT_RETENTION_DAYS).
--
-- Privacy:
--   * Raw IPs are NEVER stored. The ingest helper truncates to /24 (IPv4)
--     or /48 (IPv6) before writing.
--   * user_agent is truncated to 500 chars at write time.
--
-- Coordination: 3.1=0012, 3.2=0013, 3.3=0014, 3.4=0015, 3.5=0016.

CREATE TABLE IF NOT EXISTS fonto.audit_log (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Nullable: some events (e.g. token.mint/revoke) are user-scoped, not
    -- workspace-scoped. Workspace-scoped events MUST populate this.
    workspace_id  uuid,
    user_id       text NOT NULL,
    action        text NOT NULL,
    target_type   text,
    -- Intentionally `text` (not uuid) — some targets are slugs/hex tokens.
    target_id     text,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Truncated subnet (NEVER full IP). See lib/audit.ts.
    ip_address    text,
    user_agent    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_workspace_created_idx
    ON fonto.audit_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_created_idx
    ON fonto.audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_created_idx
    ON fonto.audit_log (action, created_at DESC);
