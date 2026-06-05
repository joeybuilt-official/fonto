-- SPDX-License-Identifier: AGPL-3.0-only
-- Task 20 — KIND: the library's primary partition (lens-based library).
--
-- KIND is a deterministic function of (mime_type, classification) computed in
-- `lib/classify/kind.ts:deriveKind` and written alongside classification in
-- processAsset. v1 domain: moment | screenshot | document | video. NULL until
-- resolved. See ADR 0001 (D1 stored column, D5 "Saved" deferred).
--
-- This migration is DDL only (column + partial index). The one-time backfill
-- of already-`ready` rows is run as a separate, gated UPDATE on apply; the
-- in-flight `captured` backlog self-populates as the worker drains it.
--
-- Additive + idempotent. Safe to re-run.

ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS kind text;

-- Lens faceting + per-kind bucket counts. Partial on active rows (the only
-- rows any lens lists) keeps the BTree small.
CREATE INDEX IF NOT EXISTS assets_workspace_kind_idx
  ON fonto.assets (workspace_id, kind)
  WHERE lifecycle_state = 'active';
