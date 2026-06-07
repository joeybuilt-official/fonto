-- Migration 0037: Composite index on (workspace_id, place_name) for the
-- Places collection GROUP BY query. Partial index (WHERE place_name IS NOT NULL)
-- keeps it small — only rows with reverse-geocoded GPS data are indexed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS assets_workspace_placename_idx
  ON fonto.assets (workspace_id, place_name)
  WHERE place_name IS NOT NULL;
