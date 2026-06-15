-- Intelligence Core — Phase 4 (ADR-0002/0003): the inference (proposal) store.
--
-- fonto.image_date_inference holds ONE fused date proposal per asset, produced by
-- the pure fusion engine (lib/fusion) from the asset's image_date_evidence rows.
-- This is PROPOSE-DON'T-OVERWRITE (ADR-0005): the asset's authoritative
-- `captured_at` is NEVER written from here — the proposal lives in its own table
-- until an operator confirms it in the Phase 6 review queue (status->confirmed).
--
--   map_estimate / map_precision  — MAP cell + derived precision (day|month|year)
--   ci_low / ci_high              — bounding range of the 90% HDI
--   confidence                    — 0..1 (peak mass, HDI-penalised; cold-start->low)
--   conflict_flag / conflict_detail — stored captured_at falls outside the HDI
--   status {inferred|confirmed|quarantined|overridden}
--   explanation                   — ranked evidence contributions (the artifact)
--   depends_on                    — { person_ids, fact_ids, model_versions,
--                                     neighbor_asset_ids } for ADR-0006 re-audit
--   computed_at                   — when this proposal was last fused
--
-- Idempotent. Head before this = 0044_intelligence_evidence.

CREATE TABLE IF NOT EXISTS fonto.image_date_inference (
  asset_id        uuid PRIMARY KEY,
  map_estimate    date,
  map_precision   text,
  ci_low          date,
  ci_high         date,
  confidence      real NOT NULL DEFAULT 0,
  conflict_flag   boolean NOT NULL DEFAULT false,
  conflict_detail jsonb,
  status          text NOT NULL DEFAULT 'inferred',
  explanation     jsonb,
  depends_on      jsonb,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE fonto.image_date_inference
    ADD CONSTRAINT image_date_inference_status_check
    CHECK (status IN ('inferred', 'confirmed', 'quarantined', 'overridden'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.image_date_inference
    ADD CONSTRAINT image_date_inference_precision_check
    CHECK (map_precision IS NULL OR map_precision IN ('year', 'month', 'day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Phase 6 review queue lanes: list conflicted / low-confidence proposals.
CREATE INDEX IF NOT EXISTS image_date_inference_status_idx
  ON fonto.image_date_inference (status);

-- Partial index for the conflict lane (the minority of rows).
CREATE INDEX IF NOT EXISTS image_date_inference_conflict_idx
  ON fonto.image_date_inference (status)
  WHERE conflict_flag = true;
