-- Jex ADR-004 passkey hardening.
-- 1. passkey_challenges.user_handle: opaque handle (ADR-004 C1) minted at
--    startRegistration, copied to passkey_credentials.user_handle at finish —
--    the local Better Auth user id never becomes the cross-app anchor.
-- 2. Challenge-keyed anon auth: unique index on challenge so concurrent
--    anonymous logins can't clobber each other's rows.
-- 3. user_handle on credentials is NOT unique: all of a user's credentials
--    share one handle by design, so unique-per-handle blocks a 2nd passkey.

ALTER TABLE fonto.passkey_challenges
  ADD COLUMN IF NOT EXISTS user_handle text;

DELETE FROM fonto.passkey_challenges WHERE expires_at < now();

CREATE UNIQUE INDEX IF NOT EXISTS passkey_challenges_challenge_idx
  ON fonto.passkey_challenges (challenge);

DROP INDEX IF EXISTS fonto.passkey_credentials_user_handle_idx;

CREATE INDEX IF NOT EXISTS passkey_credentials_user_handle_idx
  ON fonto.passkey_credentials (user_handle);
