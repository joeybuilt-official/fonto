-- SPDX-License-Identifier: MIT
-- Phase 0.3 (Fonto → Immich parity): persist EXIF / IPTC / XMP at ingest.
--
-- Adds a raw metadata blob plus the high-traffic fields lifted out for
-- indexable queries (capture date already exists on the table; this commit
-- starts populating it from EXIF instead of upload time). GPS columns are
-- indexed for future map / "near here" browsing.

ALTER TABLE fonto.assets
  ADD COLUMN IF NOT EXISTS exif          jsonb,
  ADD COLUMN IF NOT EXISTS latitude      double precision,
  ADD COLUMN IF NOT EXISTS longitude     double precision,
  ADD COLUMN IF NOT EXISTS camera_make   text,
  ADD COLUMN IF NOT EXISTS camera_model  text,
  ADD COLUMN IF NOT EXISTS lens_model    text,
  ADD COLUMN IF NOT EXISTS focal_length  real,
  ADD COLUMN IF NOT EXISTS f_number      real,
  ADD COLUMN IF NOT EXISTS iso           integer,
  ADD COLUMN IF NOT EXISTS exposure_time text,
  ADD COLUMN IF NOT EXISTS orientation   integer,
  ADD COLUMN IF NOT EXISTS width_px      integer,
  ADD COLUMN IF NOT EXISTS height_px     integer;

-- Timeline browsing: workspace assets ordered by capture date (newest first).
-- Matches the photo-roll view planned for parity with Immich's main timeline.
CREATE INDEX IF NOT EXISTS assets_workspace_captured_at_idx
  ON fonto.assets (workspace_id, captured_at DESC);

-- Map / bounding-box queries on GPS. Plain btree — good enough for
-- ORDER BY + range scans; PostGIS-grade indexing is out of scope here.
CREATE INDEX IF NOT EXISTS assets_lat_lon_idx
  ON fonto.assets (latitude, longitude);
