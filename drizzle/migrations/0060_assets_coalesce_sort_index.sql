-- Renumbered 0058 -> 0060: the original branch predates 0058_library_perf_indexes.sql
-- and 0059_thumbnail_state.sql, which now occupy those numbers on main.
-- Only the index is taken from task/library-bucket-cache; its Valkey caching was
-- superseded by a better implementation already on main (sorted full-param cache
-- key vs the branch's manually-enumerated one, which could miss filter params).

-- Partial index backing the timeline scrubber's COALESCE(captured_at, created_at)
-- sort so the bucket-count query (app/api/v1/assets/buckets/route.ts) stays
-- index-driven for active-lifecycle assets.
-- Reversible: DROP INDEX assets_workspace_coalesce_sort_active_idx;
-- Cost: small. Index size scales with row count (active rows × 24 bytes/entry).

CREATE INDEX IF NOT EXISTS assets_workspace_coalesce_sort_active_idx
  ON fonto.assets (workspace_id, COALESCE(captured_at, created_at) DESC)
  WHERE lifecycle_state = 'active';
