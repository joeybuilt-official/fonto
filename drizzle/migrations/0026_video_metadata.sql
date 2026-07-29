-- SPDX-License-Identifier: MIT
-- Phase 8a — video probe columns on fonto.assets.
--
-- ffprobe writes these during processAsset for video/* mime. Optional
-- everywhere so non-video rows can leave them NULL (no migration of
-- existing images needed).
--   duration_seconds  — real seconds (float; ffprobe returns sub-sec
--                       precision and the player UI uses it for the
--                       scrubber range).
--   video_codec       — string from ffprobe codec_name ('h264',
--                       'hevc', 'av1', etc.); used by the player to
--                       pick a transcode path in Phase 8b.
--   video_width / video_height — pixel dims of the video stream;
--                       displayed in asset detail + used for
--                       aspect-ratio hint in the grid tile.

ALTER TABLE fonto.assets
  ADD COLUMN duration_seconds DOUBLE PRECISION,
  ADD COLUMN video_codec TEXT,
  ADD COLUMN video_width INTEGER,
  ADD COLUMN video_height INTEGER;
