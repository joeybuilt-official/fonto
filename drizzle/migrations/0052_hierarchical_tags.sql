-- M10 / ADR 0013 — hierarchical tags via adjacency (parent_id) + materialized
-- path. Additive + reversible: rollback is `ALTER TABLE fonto.tags DROP COLUMN
-- parent_id, DROP COLUMN path;` and tags revert to flat with no asset-tag loss.

ALTER TABLE fonto.tags
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES fonto.tags(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS path text NOT NULL DEFAULT '';

-- Backfill every existing tag as a root: path = '/<id>/'. Idempotent — only
-- rows still carrying the empty default are touched.
UPDATE fonto.tags SET path = '/' || id::text || '/' WHERE path = '';

-- (workspace_id, parent_id) — list a node's direct children cheaply.
CREATE INDEX IF NOT EXISTS tags_workspace_parent_idx
  ON fonto.tags (workspace_id, parent_id);

-- (workspace_id, path) with text_pattern_ops so `path LIKE '<prefix>%'`
-- descendant filters use the index.
CREATE INDEX IF NOT EXISTS tags_workspace_path_idx
  ON fonto.tags (workspace_id, path text_pattern_ops);
