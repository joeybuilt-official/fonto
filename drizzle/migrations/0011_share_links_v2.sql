-- SPDX-License-Identifier: MIT
-- Phase 2.5 — share_links overhaul (see ADR 0004).
--
-- Additive only on share_links so existing rows + token-based URLs keep
-- working. We also create share_link_views for analytics / abuse forensics.

-- ── share_links: new columns ────────────────────────────────────────────────
ALTER TABLE fonto.share_links
  ADD COLUMN IF NOT EXISTS target_type    text,
  ADD COLUMN IF NOT EXISTS target_id      uuid,
  ADD COLUMN IF NOT EXISTS slug           text,
  ADD COLUMN IF NOT EXISTS password_hash  text,
  ADD COLUMN IF NOT EXISTS allow_download boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_views      integer,
  ADD COLUMN IF NOT EXISTS view_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked        boolean NOT NULL DEFAULT false;

-- ── Backfill — preserve old links ──────────────────────────────────────────
-- Old rows: targetType='asset', targetId=asset_id, slug = first 8 chars of
-- token (best-effort, won't collide because original token is 24-byte base64url).
UPDATE fonto.share_links
   SET target_type = 'asset',
       target_id   = asset_id
 WHERE target_type IS NULL
   AND asset_id IS NOT NULL;

UPDATE fonto.share_links
   SET slug = substring(token from 1 for 8)
 WHERE slug IS NULL;

UPDATE fonto.share_links
   SET revoked = (revoked_at IS NOT NULL)
 WHERE revoked = false AND revoked_at IS NOT NULL;

-- Now lock the new not-null invariants in.
ALTER TABLE fonto.share_links
  ALTER COLUMN target_type SET NOT NULL,
  ALTER COLUMN target_id   SET NOT NULL,
  ALTER COLUMN slug        SET NOT NULL,
  ALTER COLUMN target_type SET DEFAULT 'asset';

-- expires_at: drop NOT NULL — NULL now means "never expires".
ALTER TABLE fonto.share_links
  ALTER COLUMN expires_at DROP NOT NULL;

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS share_links_slug_idx
  ON fonto.share_links (slug);
CREATE INDEX IF NOT EXISTS share_links_target_idx
  ON fonto.share_links (target_type, target_id);
CREATE INDEX IF NOT EXISTS share_links_workspace_active_idx
  ON fonto.share_links (workspace_id, revoked);

-- NOTE(2.6): `asset_id` is intentionally NOT dropped here. Phase 2.5 keeps
-- it as a redundant mirror of `target_id` for one release so any client that
-- still reads it doesn't break. Plan to drop in 2.6.

-- ── share_link_views ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.share_link_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_link_id uuid NOT NULL,
  accessed_at   timestamptz NOT NULL DEFAULT now(),
  ip_hash       text,
  user_agent    text,
  success       boolean NOT NULL DEFAULT true,
  referer       text
);

CREATE INDEX IF NOT EXISTS share_link_views_link_accessed_idx
  ON fonto.share_link_views (share_link_id, accessed_at DESC);
