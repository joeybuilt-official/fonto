-- SPDX-License-Identifier: MIT
-- Review-at-scale (M15.1 / ADR 0012) — reason-bucketing for the date review queue.
--
-- The reconciliation review queue can run to tens of thousands of items; users
-- must clear them in PATTERNS, grouped by the evidence source that produced the
-- inferred date (exif / filename / ocr_date / fs_mtime / …). That source already
-- exists, but only inside the ranked `explanation` JSONB — not queryable.
--
--   * Denormalise the DOMINANT evidence source onto a STORED GENERATED column
--     derived from the highest-contribution explanation entry (the array is
--     contribution-ranked, so element 0). Generated + STORED means existing
--     rows are computed on ADD COLUMN (auto-backfill) and the column stays in
--     lockstep with `explanation` forever — no app-side write, no drift.
--   * Add a composite index so the bucketed GROUP BY count over the review band
--     is cheap at 140k+ rows.
--
-- Additive + idempotent (IF NOT EXISTS). No destructive statements.
-- Head before this = 0049_delta_sync_tombstones.

-- 1. Dominant evidence source (generated, auto-backfilled) -------------
ALTER TABLE fonto.image_date_inference
  ADD COLUMN IF NOT EXISTS dominant_evidence_source text
  GENERATED ALWAYS AS (explanation -> 0 ->> 'evidenceType') STORED;

-- 2. Bucket grouping index --------------------------------------------
-- Supports: WHERE status='inferred' GROUP BY conflict_flag, dominant_evidence_source
CREATE INDEX IF NOT EXISTS image_date_inference_bucket_idx
  ON fonto.image_date_inference (status, conflict_flag, dominant_evidence_source);
