-- Jex ADR-004 Fallback 3: one_time_links for legacy email-and-password → passkey bridge.
-- Token is issued from an authenticated session only (ADR-004 §hard rule).
-- Namespaced to Fonto's OWN `fonto` schema (shared pushd.auth avoided); FK to
-- the shared auth.user only.

CREATE TABLE IF NOT EXISTS fonto.one_time_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);

CREATE INDEX IF NOT EXISTS one_time_links_token_idx ON fonto.one_time_links (token);
CREATE INDEX IF NOT EXISTS one_time_links_user_id_idx ON fonto.one_time_links (user_id);
