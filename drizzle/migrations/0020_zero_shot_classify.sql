-- SPDX-License-Identifier: MIT
-- Phase 4.6 — zero-shot CLIP classify + auto-tag.
--
-- Adds four nullable columns to `fonto.assets`:
--   sub_classification    sub-taxonomy key (e.g. "food", "portrait")
--   classify_method       "clip" | "llm-fallback" — which path produced the answer
--   classify_confidence   top-1 cosine in [0, 1] (4-byte real)
--   auto_tagged_at        timestamp of the last successful auto-tag pass
--
-- All four are additive ADD COLUMN IF NOT EXISTS — safe to re-run, safe to
-- apply on any environment running migrations 0001..0019. No backfill: rows
-- that processed before this migration simply have NULLs in the new columns
-- until the asset is re-processed (or until a future re-classification cron
-- sweeps them, which is what `auto_tagged_at IS NULL` is meant to find).

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS sub_classification text;

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS classify_method text;

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS classify_confidence real;

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS auto_tagged_at timestamptz;

-- Smart-collection facet support: "All food photos" is a common ask, and
-- we want it to be cheap. Partial index keeps the BTree small — the vast
-- majority of rows have a NULL sub_classification.
CREATE INDEX IF NOT EXISTS assets_workspace_sub_classification_idx
    ON fonto.assets (workspace_id, sub_classification)
    WHERE sub_classification IS NOT NULL;
