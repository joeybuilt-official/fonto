-- SPDX-License-Identifier: MIT
-- Phase 1 (faces/UX) — dedicated face-crop derivative key on face_instances.
--
-- A stored square face crop (sharp `.extract` of the bbox + ~30% padding,
-- EXIF-orientation-correct, ~256px webp) is generated at face-detect time and
-- uploaded to R2 at `derivatives/face/{faceId}.webp`. This column holds that
-- key so the People grid + person detail + asset face overlay render a sharp,
-- centered crop instead of CSS-zooming a whole-frame derivative.
--
-- NULL until the crop lands (new faces crop inline at detect; existing faces
-- are filled by the gated `backfill-face-crops` maintenance job). See ADR 0001
-- (D1). Additive + idempotent — safe to re-run.

ALTER TABLE fonto.face_instances
  ADD COLUMN IF NOT EXISTS face_crop_key text;

-- The backfill job scans for un-cropped faces; a partial index keeps that
-- "WHERE face_crop_key IS NULL" sweep cheap as the column fills in.
CREATE INDEX IF NOT EXISTS face_instances_crop_pending_idx
  ON fonto.face_instances (workspace_id)
  WHERE face_crop_key IS NULL;
