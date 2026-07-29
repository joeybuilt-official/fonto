-- SPDX-License-Identifier: MIT
-- Review-at-scale (M15.2) — undo snapshot for bulk bucket actions.
--
-- A bulk apply-to-bucket (confirm/reject/quarantine) needs to be undoable from
-- the UI snackbar. We snapshot the pre-action state ONTO the (1:1) inference
-- row in a `review_undo` jsonb ({priorStatus, priorCapturedAt}) when the bulk
-- action runs; undo reverts status + captured_at from it and clears the column.
-- One column, no new table, no per-action row explosion. Non-null = undoable.
--
-- Additive + idempotent. Head before this = 0050_review_evidence_buckets.

ALTER TABLE fonto.image_date_inference
  ADD COLUMN IF NOT EXISTS review_undo jsonb;
