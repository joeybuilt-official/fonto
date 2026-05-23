-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 3.4 — favorites + 0..5 star ratings on assets.
--
-- Two scalar columns and two partial indexes. Additive; no backfill needed
-- (defaults are the "unset" values: not-favorited, unrated).
--
-- Coordination note: 3.1=0012, 3.2=0013, 3.3=0014, 3.4=0015, 3.5=0016.

-- ── assets: new columns ─────────────────────────────────────────────────────
ALTER TABLE fonto.assets
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rating      integer NOT NULL DEFAULT 0;

-- Database-level guard: rating must be in 0..5. API also validates, but
-- defense in depth keeps stray writers (psql, scripts, future code paths)
-- from corrupting the column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_rating_range_chk'
  ) THEN
    ALTER TABLE fonto.assets
      ADD CONSTRAINT assets_rating_range_chk CHECK (rating >= 0 AND rating <= 5);
  END IF;
END$$;

-- ── partial indexes ─────────────────────────────────────────────────────────
-- Favorites: most assets are NOT favorited, so a partial index over the
-- "true" rows is dramatically smaller than a full BTree on the boolean.
CREATE INDEX IF NOT EXISTS assets_workspace_favorite_idx
  ON fonto.assets (workspace_id)
  WHERE is_favorite = true;

-- Ratings: same idea — most assets are unrated. The index is on
-- (workspace_id, rating) so "ratingMin = 4" can scan a contiguous range.
CREATE INDEX IF NOT EXISTS assets_workspace_rating_idx
  ON fonto.assets (workspace_id, rating)
  WHERE rating > 0;
