-- SPDX-License-Identifier: MIT
-- Public, time-bounded share tokens for individual assets.

CREATE TABLE IF NOT EXISTS fonto.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS share_links_token_idx ON fonto.share_links (token);
CREATE INDEX IF NOT EXISTS share_links_asset_id_idx ON fonto.share_links (asset_id);
