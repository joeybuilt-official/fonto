-- Jex ADR-004: passkey_challenges (short-lived) + passkey_credentials tables.
-- Stored in the auth schema alongside Better Auth tables.

CREATE TABLE IF NOT EXISTS auth.passkey_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  challenge   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);

CREATE INDEX IF NOT EXISTS passkey_challenges_user_id_idx
  ON auth.passkey_challenges (user_id);

CREATE TABLE IF NOT EXISTS auth.passkey_credentials (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  user_handle         text NOT NULL,
  public_key          bytea NOT NULL,
  counter             bigint NOT NULL DEFAULT 0,
  device_type         text NOT NULL,
  backed_up           boolean NOT NULL DEFAULT false,
  transports          text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz
);

CREATE INDEX IF NOT EXISTS passkey_credentials_user_id_idx
  ON auth.passkey_credentials (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS passkey_credentials_user_handle_idx
  ON auth.passkey_credentials (user_handle);
