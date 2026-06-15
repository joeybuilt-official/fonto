-- T2.4 fonto-perf-audit 2026-06-15
-- 4x4 WebP LQIP for grid placeholders. Removes white flash + reduces CLS.
-- Stored as a data URL (~200 bytes/row). Backfill via scripts/backfill-lqip.ts.
-- Reversible: ALTER TABLE fonto.assets DROP COLUMN lqip;
ALTER TABLE fonto.assets ADD COLUMN lqip text;
