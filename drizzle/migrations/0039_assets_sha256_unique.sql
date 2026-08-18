-- SPDX-License-Identifier: MIT
-- Migration 0039: partial unique index on assets(workspace_id, sha256) WHERE active.
--
-- Split out of 0038 (ADR 0001 C4). Closes the dedup race: two concurrent import
-- workers can otherwise insert the same SHA-256 before either sees the other's
-- row. The partial predicate (lifecycle_state = 'active') keeps the index small
-- and speeds the dedup SELECT in createAssetRow.
--
-- ⚠⚠⚠ DEDUP PRE-PASS REQUIRED BEFORE THIS WILL APPLY ⚠⚠⚠
-- This index FAILS to build if the DB has two or more active rows sharing a
-- (workspace_id, sha256) pair. As of 2026-06-09 prod had 990 such groups
-- (1078 extra rows). Run the pre-pass first:
--
--   SELECT workspace_id, sha256, count(*)
--   FROM fonto.assets
--   WHERE lifecycle_state = 'active'
--   GROUP BY workspace_id, sha256
--   HAVING count(*) > 1;
--
-- For each group, keep ONE canonical row (decide: oldest created_at, or the one
-- with the most tag/collection/face references) and soft-delete the rest
-- (lifecycle_state <> 'active'), reassigning any tag/collection/share/face
-- references off the losers onto the survivor FIRST. This touches user data and
-- must be reviewed per-environment — do it as a separate audited step, NOT here.
--
-- Transaction note: CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a tx; the
-- raw-psql runner wraps each file in one tx, so this uses a plain (locking)
-- build. On ~10.5k assets the lock is brief. For a much larger table, run this
-- single statement out-of-band as CREATE UNIQUE INDEX CONCURRENTLY.

CREATE UNIQUE INDEX IF NOT EXISTS assets_workspace_sha256_active_uidx
    ON fonto.assets (workspace_id, sha256)
    WHERE lifecycle_state = 'active';
