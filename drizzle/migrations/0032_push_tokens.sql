-- SPDX-License-Identifier: MIT
-- Phase 6.4 — per-device FCM push tokens.
--
-- One row per (user, device). `device_id` is a stable client-generated id
-- so re-registering the same device upserts (no duplicate rows). `platform`
-- is android | ios | web. Tokens are deregistered on sign-out (DELETE) and
-- pruned by the dispatcher when FCM reports them unregistered.

CREATE TABLE IF NOT EXISTS fonto.push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  device_id text NOT NULL,
  token text NOT NULL,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_user_device_idx
  ON fonto.push_tokens (user_id, device_id);
CREATE INDEX IF NOT EXISTS push_tokens_user_idx
  ON fonto.push_tokens (user_id);
