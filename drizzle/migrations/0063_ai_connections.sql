-- 0063_ai_connections.sql
-- Fleet decoupling (2026-09) — app-owned, user-configurable AI connections.
--
-- Replaces the sibling-app AI path. AI used to route through a peer's provider
-- chain (Plexo Core); each user now configures their OWN connection (label,
-- base URL, model, API key), and the deployment's env connection is the
-- fallback. The API key is stored encrypted (AES-256-GCM,
-- `lib/crypto/secret-box.ts` — key derived from AUTH_SECRET) and is never
-- returned by any read path (masked last-4 only).
--
-- Why this is IDENTITY-ADJACENT but not identity: Fonto already owns its
-- workspaces (`fonto.workspaces`, migration-era baseline); the only thing that
-- lived in the sibling app was provider credentials and the workspace id used
-- for cost attribution there. That is a config concern, so it lands here as a
-- per-user table rather than a workspace row.
--
-- Safety: additive + idempotent. CREATE TABLE IF NOT EXISTS / CREATE INDEX IF
-- NOT EXISTS only — re-running is a no-op. Forward-only; applied on deploy per
-- AGENTS.md.

CREATE TABLE IF NOT EXISTS fonto.ai_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Matches Better Auth `user.id` (text). Cross-schema; FK enforced in SQL.
  user_id            text NOT NULL,
  label              text NOT NULL,
  -- OpenAI-compatible base URL, no trailing slash (normalised on write).
  base_url           text NOT NULL,
  model              text NOT NULL,
  -- AES-256-GCM ciphertext: v1:<ivB64>:<tagB64>:<ctB64>. Never plaintext.
  encrypted_api_key  text NOT NULL,
  -- Resolution uses the user's default when a caller does not name one.
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_connections_user_idx
  ON fonto.ai_connections (user_id);

-- At most ONE default per user — enforced in the database so a race cannot
-- leave a user with two "default" connections and non-deterministic AI routing.
CREATE UNIQUE INDEX IF NOT EXISTS ai_connections_user_default_idx
  ON fonto.ai_connections (user_id)
  WHERE is_default;
