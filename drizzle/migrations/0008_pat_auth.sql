-- SPDX-License-Identifier: MIT
-- Phase 2.1: Personal Access Tokens (PATs).
--
-- Programmatic API authentication for mobile + CLI clients. The plaintext
-- token is shown to the user exactly once at creation time; only a SHA-256
-- digest is stored. Wire format: `fonto_pat_<id>_<secret>` — verification
-- looks up by `id`, recomputes the digest of `secret`, and timing-safe
-- compares against `secret_hash`.
--
-- We own this table (rather than using Better Auth's `apiKey` plugin) because
-- that plugin is not shipped in better-auth 1.6.9. The column names mirror
-- what the plugin would have given us so a future swap to the plugin is a
-- mechanical rename, not a rewrite.

CREATE TABLE IF NOT EXISTS fonto.api_keys (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Owner. Matches Better Auth's `auth.user.id` (text). No cross-schema FK.
    user_id       text NOT NULL,
    name          text NOT NULL,
    -- Public token-class prefix (e.g. "fonto_pat_"). Plan default.
    prefix        text NOT NULL DEFAULT 'fonto_pat_',
    -- First/last 4 chars of the SECRET portion (not the prefix) — UI only.
    first_four    text NOT NULL,
    last_four     text NOT NULL,
    -- SHA-256 hex of the secret portion.
    secret_hash   text NOT NULL,
    -- Granted scopes, subset of ['read','write','admin']. JSONB so the
    -- vocabulary can grow without a migration.
    scopes        jsonb NOT NULL DEFAULT '["read"]'::jsonb,
    metadata      jsonb,
    expires_at    timestamptz,
    last_used_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_user_id_idx
    ON fonto.api_keys (user_id);
CREATE INDEX IF NOT EXISTS api_keys_secret_hash_idx
    ON fonto.api_keys (secret_hash);
