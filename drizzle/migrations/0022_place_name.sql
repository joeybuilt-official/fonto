-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 5.2 — GPS + map view.
--
-- Adds one nullable column to `fonto.assets`:
--   place_name  human-readable nearest-place label rendered under the map
--               pin and at the bottom of the lightbox (e.g. "Reykjavík, IS").
--
-- Computed at ingest by `lib/geocoder.ts:nearestPlace()` (KD-tree lookup
-- over the bundled GeoNames `cities500` dataset). Existing rows are
-- backfilled by `scripts/backfill-place-names.ts`.
--
-- Additive ADD COLUMN IF NOT EXISTS — safe to re-run, safe to apply on
-- any environment running migrations 0001..0021. No backfill in-SQL: the
-- KD-tree lives in app code, not Postgres.
--
-- The (latitude, longitude) btree (`assets_lat_lon_idx`) was introduced
-- back in Phase 0.3 (EXIF extraction) and is reused by the new
-- `/api/v1/assets/within-bbox` map-pan handler. No new index here.

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS place_name text;
