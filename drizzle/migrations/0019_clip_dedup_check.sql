-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 4.5: CLIP-similarity duplicate detection (second pass after pHash).
--
-- Adds a `clip_dedup_checked_at` column to `fonto.assets`. The CLIP-dedup
-- pass — `nearestNeighbors(workspaceId, clip_vec, threshold=0.92)` — runs
-- either inline in `createAssetRow()` (preferred, sub-2s budget) or via the
-- BullMQ `clip-dedup-check` worker fallback when the inline budget is missed.
-- This column is stamped whichever way the check completes so the worker
-- sweep can ignore already-checked rows.
--
-- Phases 4.3 (vector NN index) and 4.2 (CLIP embedding service) ship their
-- own columns/migrations (`assets.clip_vec`, the pgvector index). This
-- migration is intentionally narrow — adding only the dedup-check
-- bookkeeping. If 4.3 hasn't landed, this column is still safe to add and
-- the worker just no-ops (the stub `nearestNeighbors()` returns []).
--
-- Migration coordination: 0016 = directory_path (3.5), 0017 reserved for
-- 4.3 (clip_vec + index), 0018 reserved for 4.4, 0019 = this one.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS clip_dedup_checked_at timestamptz;

-- Partial index to drive the worker sweep: rows that have an embedding but
-- haven't been dedup-checked yet. Kept small via the WHERE clause — most
-- active rows are eventually either embedded-and-checked (drop out via the
-- WHERE) or skipped (non-image).
CREATE INDEX IF NOT EXISTS assets_clip_dedup_pending_idx
    ON fonto.assets (workspace_id, created_at)
    WHERE clip_dedup_checked_at IS NULL;
