-- T1.5 fonto-perf-audit 2026-06-15
-- Partial composite indexes for the 95th-percentile grid/search/timeline read.
-- Reversible: DROP INDEX assets_workspace_captured_active_idx;
--             DROP INDEX assets_workspace_created_active_idx;
-- Cost: small. Index size scales with row count (active rows × 24 bytes/entry).

CREATE INDEX IF NOT EXISTS assets_workspace_captured_active_idx
  ON fonto.assets (workspace_id, captured_at DESC)
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS assets_workspace_created_active_idx
  ON fonto.assets (workspace_id, created_at DESC)
  WHERE lifecycle_state = 'active';
