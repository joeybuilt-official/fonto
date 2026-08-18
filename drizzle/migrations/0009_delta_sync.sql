-- SPDX-License-Identifier: MIT
-- Phase 2.3: cursor-based delta sync.
--
-- Adds a monotonic `seq bigint` column to every syncable entity
-- (assets, tags, collections), plus a small `workspace_seq` table that
-- holds one row per workspace with one column per entity kind. The
-- application allocates new seq values via `lib/db/seq.ts:nextSeq()`
-- which is an atomic INSERT-or-UPDATE on `workspace_seq`.
--
-- Tombstones are NOT stored separately. A "delete" sync entry is
-- emitted whenever `deleted_at` is non-null (trash) or `purged_at` is
-- non-null (hard-delete). The asset row itself stays in the table (or,
-- for hard-deletes, is removed entirely — but those are rare and the
-- client reconciles via the trash signal on the same row first).
--
-- IDEMPOTENCY: every ADD COLUMN uses IF NOT EXISTS; the backfill is
-- scoped `WHERE seq IS NULL` so re-running this migration is a no-op.

-- 1. Add seq columns ---------------------------------------------------

ALTER TABLE fonto.assets       ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE fonto.tags         ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE fonto.collections  ADD COLUMN IF NOT EXISTS seq bigint;

-- 2. Per-workspace counter table --------------------------------------

CREATE TABLE IF NOT EXISTS fonto.workspace_seq (
    workspace_id    uuid PRIMARY KEY,
    asset_seq       bigint NOT NULL DEFAULT 0,
    tag_seq         bigint NOT NULL DEFAULT 0,
    collection_seq  bigint NOT NULL DEFAULT 0
);

-- 3. Backfill existing rows -------------------------------------------
-- For each entity table, assign seq = row_number() within workspace
-- ordered by created_at. Rows that already have a seq (re-run scenario)
-- are left alone via the WHERE seq IS NULL guard.

UPDATE fonto.assets AS a
   SET seq = sub.rn
  FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY workspace_id
                 ORDER BY created_at, id
               ) AS rn
          FROM fonto.assets
         WHERE seq IS NULL
       ) AS sub
 WHERE a.id = sub.id
   AND a.seq IS NULL;

UPDATE fonto.tags AS t
   SET seq = sub.rn
  FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY workspace_id
                 ORDER BY created_at, id
               ) AS rn
          FROM fonto.tags
         WHERE seq IS NULL
       ) AS sub
 WHERE t.id = sub.id
   AND t.seq IS NULL;

UPDATE fonto.collections AS c
   SET seq = sub.rn
  FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY workspace_id
                 ORDER BY created_at, id
               ) AS rn
          FROM fonto.collections
         WHERE seq IS NULL
       ) AS sub
 WHERE c.id = sub.id
   AND c.seq IS NULL;

-- 4. Seed workspace_seq from the per-workspace MAX(seq) ---------------
-- INSERT-or-UPDATE so a re-run keeps the counter at-or-above the
-- highest existing seq (never goes backward).

INSERT INTO fonto.workspace_seq (workspace_id, asset_seq, tag_seq, collection_seq)
SELECT w.workspace_id,
       COALESCE(a.max_seq, 0),
       COALESCE(t.max_seq, 0),
       COALESCE(c.max_seq, 0)
  FROM (
        SELECT workspace_id FROM fonto.assets
        UNION
        SELECT workspace_id FROM fonto.tags
        UNION
        SELECT workspace_id FROM fonto.collections
       ) AS w
  LEFT JOIN (
        SELECT workspace_id, MAX(seq) AS max_seq
          FROM fonto.assets
         GROUP BY workspace_id
       ) AS a  ON a.workspace_id  = w.workspace_id
  LEFT JOIN (
        SELECT workspace_id, MAX(seq) AS max_seq
          FROM fonto.tags
         GROUP BY workspace_id
       ) AS t  ON t.workspace_id  = w.workspace_id
  LEFT JOIN (
        SELECT workspace_id, MAX(seq) AS max_seq
          FROM fonto.collections
         GROUP BY workspace_id
       ) AS c  ON c.workspace_id  = w.workspace_id
ON CONFLICT (workspace_id) DO UPDATE
   SET asset_seq      = GREATEST(fonto.workspace_seq.asset_seq,      EXCLUDED.asset_seq),
       tag_seq        = GREATEST(fonto.workspace_seq.tag_seq,        EXCLUDED.tag_seq),
       collection_seq = GREATEST(fonto.workspace_seq.collection_seq, EXCLUDED.collection_seq);

-- 5. Cursor-scan indexes ----------------------------------------------

CREATE INDEX IF NOT EXISTS assets_workspace_seq_idx
    ON fonto.assets       (workspace_id, seq);
CREATE INDEX IF NOT EXISTS tags_workspace_seq_idx
    ON fonto.tags         (workspace_id, seq);
CREATE INDEX IF NOT EXISTS collections_workspace_seq_idx
    ON fonto.collections  (workspace_id, seq);
