-- Phase 9.1 — per-workspace storage quotas
--
-- quota_bytes   BIGINT nullable  — NULL = unlimited (default for all workspaces)
-- usage_bytes   BIGINT NOT NULL  — maintained incrementally; reconciled nightly
--
-- Backfill sets usage_bytes to the sum of all non-purged assets at migration
-- time. Incremental updates keep it current; the nightly reconcile job
-- corrects any drift (e.g. direct R2 deletes, bugs in the update path).

BEGIN;

ALTER TABLE fonto.workspaces
  ADD COLUMN quota_bytes BIGINT,
  ADD COLUMN usage_bytes BIGINT NOT NULL DEFAULT 0;

-- Backfill: compute current usage from active/archived/trashed assets.
-- Purged assets no longer occupy R2 storage (they have been deleted).
UPDATE fonto.workspaces w
SET usage_bytes = COALESCE(
  (SELECT SUM(a.size_bytes)
   FROM fonto.assets a
   WHERE a.workspace_id = w.id
     AND a.lifecycle_state != 'purged'),
  0
);

COMMIT;
