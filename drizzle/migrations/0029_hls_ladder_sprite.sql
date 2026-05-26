-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 8b — HLS ladder + hover-scrub sprite state on fonto.assets.
--
-- C7 resolution (2026-05-25): ship the 3-rendition ladder on day one.
-- The transcoder writes one master.m3u8 + per-rendition .m3u8s + .ts
-- segments under <workspaceId>/<assetId>/hls/ in R2.
--
-- hls_state vocabulary:
--   'idle'        — no transcode requested yet.
--   'transcoding' — job in flight.
--   'ready'       — master + all renditions in R2; the API can
--                   presign master_key.
--   'failed'      — last attempt threw; safe to re-enqueue.
--
-- hls_renditions / sprite_meta are jsonb; the schemas live in
-- lib/processing/transcodeVideoHls.ts (RenditionSpec) and
-- lib/processing/generateSpriteSheet.ts (SpriteMeta) respectively.
-- Keeping them as jsonb means future ladder additions (4K, alt codec)
-- don't require another migration.

ALTER TABLE fonto.assets
  ADD COLUMN hls_state       TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN hls_master_key  TEXT,
  ADD COLUMN hls_renditions  JSONB,
  ADD COLUMN sprite_key      TEXT,
  ADD COLUMN sprite_meta     JSONB;

ALTER TABLE fonto.assets
  ADD CONSTRAINT assets_hls_state_check
  CHECK (hls_state IN ('idle', 'transcoding', 'ready', 'failed'));

-- Useful for the orphan-HLS purger (Phase 8b cleanup) — find assets
-- with HLS content that have been trashed or purged so the worker can
-- delete the R2 keys.
CREATE INDEX assets_hls_state_lifecycle_idx
  ON fonto.assets (hls_state, lifecycle_state)
  WHERE hls_state IN ('ready', 'transcoding', 'failed');
