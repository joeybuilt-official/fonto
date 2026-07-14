-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Library performance — /app/library first-paint was ~2s of DB before the grid
-- rendered on a 150k+ asset workspace. Two root causes fixed here (a third,
-- Valkey caching of the scrubber bucket counts, ships in app code):
--
--   1. The timeline list sorts by COALESCE(captured_at, created_at) DESC, id
--      DESC. No existing captured_at-only index matches a COALESCE expression,
--      so every page seq-scanned + sorted ~158k rows (~106ms → 0.9ms with the
--      expression index below).
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. These
-- were applied ONLINE against prod with `psql` directly; apply the same way in
-- other environments (do NOT wrap in BEGIN/COMMIT). IF NOT EXISTS keeps it
-- idempotent.

CREATE INDEX CONCURRENTLY IF NOT EXISTS assets_ws_effective_captured_idx
  ON fonto.assets (workspace_id, (COALESCE(captured_at, created_at)) DESC, id DESC)
  WHERE lifecycle_state = 'active' AND motion_companion = false;

-- 2. Postgres JIT was compiling the hot library aggregates on every load
--    (~200-386ms of pure compile overhead measured). jit_above_cost raised
--    100000 → 2000000 at the cluster level so these OLTP web queries stop
--    JIT-compiling. Cluster-wide setting, recorded here for provenance:
--
--      ALTER SYSTEM SET jit_above_cost = 2000000;
--      SELECT pg_reload_conf();
