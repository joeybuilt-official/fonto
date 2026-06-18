-- SPDX-License-Identifier: AGPL-3.0-only
-- Delta-sync tombstones + projects seq.
--
-- Completes the offline-first sync surface:
--   * Adds a nullable `deleted_at timestamptz` tombstone marker to
--     `collections` and `projects` so soft-deletes surface as `delete`
--     entries on their /sync feeds (mirrors assets.deleted_at).
--   * Adds a monotonic `seq bigint` column to `projects` plus a matching
--     `project_seq` counter column on `fonto.workspace_seq`, allocated
--     app-side via `lib/db/seq.ts:nextSeq(ws, 'project')` exactly like
--     collections (see 0009_delta_sync.sql).
--
-- Additive only — no destructive statements. IDEMPOTENT: every ADD COLUMN
-- uses IF NOT EXISTS; the projects backfill is scoped `WHERE seq IS NULL`
-- and the counter seed is an upsert that never moves the counter backward.
--
-- Head before this = 0048_intelligence_elicitation.

-- 1. Tombstone markers -------------------------------------------------

ALTER TABLE fonto.collections ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE fonto.projects    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. projects.seq + workspace_seq.project_seq --------------------------

ALTER TABLE fonto.projects ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE fonto.workspace_seq
    ADD COLUMN IF NOT EXISTS project_seq bigint NOT NULL DEFAULT 0;

-- 3. Backfill existing project rows ------------------------------------
-- Assign seq = row_number() within workspace ordered by created_at, id so
-- existing projects get monotonically increasing seq values. Rows that
-- already have a seq (re-run scenario) are left alone via WHERE seq IS NULL.

UPDATE fonto.projects AS p
   SET seq = sub.rn
  FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY workspace_id
                 ORDER BY created_at, id
               ) AS rn
          FROM fonto.projects
         WHERE seq IS NULL
       ) AS sub
 WHERE p.id = sub.id
   AND p.seq IS NULL;

-- 4. Seed workspace_seq.project_seq from per-workspace MAX(seq) ---------
-- INSERT-or-UPDATE so a re-run keeps the counter at-or-above the highest
-- existing project seq (never goes backward).

INSERT INTO fonto.workspace_seq (workspace_id, project_seq)
SELECT workspace_id, COALESCE(MAX(seq), 0)
  FROM fonto.projects
 GROUP BY workspace_id
ON CONFLICT (workspace_id) DO UPDATE
   SET project_seq = GREATEST(fonto.workspace_seq.project_seq, EXCLUDED.project_seq);

-- 5. Cursor-scan index -------------------------------------------------

CREATE INDEX IF NOT EXISTS projects_workspace_seq_idx
    ON fonto.projects (workspace_id, seq);
