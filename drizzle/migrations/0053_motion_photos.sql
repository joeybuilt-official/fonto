-- M12 / ADR 0014 — Motion / Live Photos. Additive + reversible: rollback is
-- `ALTER TABLE fonto.assets DROP COLUMN motion_photo, DROP COLUMN
-- motion_video_key, DROP COLUMN motion_companion_asset_id, DROP COLUMN
-- motion_companion;` — no originals are modified, so dropping the columns
-- restores prior behaviour (embedded clip stays inside the JPEG, the Apple
-- MOV un-hides as a normal asset).

ALTER TABLE fonto.assets
  ADD COLUMN IF NOT EXISTS motion_photo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS motion_video_key text,
  ADD COLUMN IF NOT EXISTS motion_companion_asset_id uuid,
  ADD COLUMN IF NOT EXISTS motion_companion boolean NOT NULL DEFAULT false;

-- Library/grid/search read paths exclude absorbed Apple companions. Partial
-- index keeps the BTree tiny (only the handful of companion MOVs qualify) so
-- the active-read predicate `motion_companion = false` stays index-friendly
-- without bloating the table's main scans.
CREATE INDEX IF NOT EXISTS assets_motion_companion_idx
  ON fonto.assets (workspace_id)
  WHERE motion_companion = true;
