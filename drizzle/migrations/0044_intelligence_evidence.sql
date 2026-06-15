-- Intelligence Core — Phase 3 (ADR-0002): the evidence ledger + variant groups.
--
-- Three changes, all reversible:
--   1. fonto.image_date_evidence — APPEND-ONLY ledger of dated signals extracted
--      from an asset (identity bounds, scene-season hints, OCR dates, EXIF,
--      filename, fs-mtime, …). No UPDATE: supersession = insert a row with a
--      newer model_version; fusion (Phase 4) filters to the current
--      (evidence_type, model_version) and ignores the stale rows (ADR-0006).
--      `likelihood` is reserved here and left NULL — the per-evidence likelihood
--      vector is a property of the FUSION contract (ADR-0003) and is computed by
--      the Phase 4 engine from `source_detail`, not by the Phase 3 extractor.
--   2. fonto.variant_groups — candidate clusters of near-duplicate assets, seeded
--      from existing pHash + CLIP neighbours. Phase 3 only ever writes
--      status='candidate'; the destructive consolidation (canonical pick, purge)
--      is Phase 5 and gated.
--   3. fonto.assets extensions — per-asset variant membership + the quality /
--      trash columns Phase 5 needs. Kept SEPARATE from the existing
--      deleted_at/archived_at/purged_at lifecycle so a variant purge never
--      conflates with a user delete (ADR-0002).
--
-- apparent_age is a valid evidence_type with no producer in v1 (ADR-0001 D4):
-- zero rows until the Plexo age Tool ships; fusion ignores absent evidence by
-- construction.
--
-- Idempotent. Head before this = 0043_temporal_facts.

-- ── image_date_evidence (append-only ledger) ────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.image_date_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL,
  evidence_type text NOT NULL,
  -- Reserved: sparse monthly-grid likelihood vector (ADR-0003). NULL in Phase 3;
  -- the fusion engine computes + caches it from source_detail in Phase 4.
  likelihood    jsonb,
  -- The structured raw signal the extractor pulled (parsed dates, person bounds,
  -- season labels, exif source, …). This is what the Phase 4 likelihood fns read.
  source_detail jsonb NOT NULL,
  -- Provenance of the producing model/rule. A bump re-extracts ONLY this
  -- evidence_type's rows for affected assets (ADR-0006). For perception-backed
  -- types (scene_season) this is the Plexo model id; for Fonto-local rules it is
  -- a rule version string ("exif@1").
  model_version text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE fonto.image_date_evidence
    ADD CONSTRAINT image_date_evidence_type_check
    CHECK (evidence_type IN (
      'identity_bound', 'apparent_age', 'trip_match', 'scene_season',
      'ocr_date', 'exif', 'filename', 'fs_mtime', 'cluster_propagation',
      'co_occurrence'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Fusion reads every current row for an asset; re-audit re-extracts a single type.
CREATE INDEX IF NOT EXISTS image_date_evidence_asset_type_idx
  ON fonto.image_date_evidence (asset_id, evidence_type);

-- Idempotent replace probe: the extractor deletes prior rows for the same
-- (asset_id, evidence_type, model_version) before re-inserting, so a re-run with
-- an unchanged model_version is a no-op-equivalent (older versions are retained).
CREATE INDEX IF NOT EXISTS image_date_evidence_asset_type_version_idx
  ON fonto.image_date_evidence (asset_id, evidence_type, model_version);

-- ── variant_groups (near-duplicate candidate clusters) ──────────────────────
CREATE TABLE IF NOT EXISTS fonto.variant_groups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  -- A stable representative key for the cluster (e.g. the seed asset's pHash hex
  -- or smallest member id). Diagnostic / dedup-of-groups aid; not load-bearing.
  perceptual_key      text,
  -- The chosen survivor. NULL while status='candidate' — Phase 5 picks it from a
  -- deterministic quality score before consolidation (ADR-0004). Soft FK.
  canonical_asset_id  uuid,
  -- Tightest pairwise similarity that bound the group together (0..1). Drives
  -- the Phase 5 review-vs-auto gate threshold.
  grouping_confidence real,
  status              text NOT NULL DEFAULT 'candidate',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE fonto.variant_groups
    ADD CONSTRAINT variant_groups_status_check
    CHECK (status IN ('candidate', 'confirmed', 'consolidated'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS variant_groups_workspace_status_idx
  ON fonto.variant_groups (workspace_id, status);

-- ── assets: variant membership + quality/trash (Phase 5 inputs) ─────────────
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS variant_group_id uuid;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS is_canonical boolean NOT NULL DEFAULT false;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS quality_metrics jsonb;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS consolidation_state text NOT NULL DEFAULT 'none';
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS trash_purge_at timestamptz;

DO $$ BEGIN
  ALTER TABLE fonto.assets
    ADD CONSTRAINT assets_consolidation_state_check
    CHECK (consolidation_state IN ('none', 'trashed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Membership scans ("list this group's assets") — partial on grouped rows only,
-- which are the minority, so the BTree stays small.
CREATE INDEX IF NOT EXISTS assets_variant_group_idx
  ON fonto.assets (variant_group_id)
  WHERE variant_group_id IS NOT NULL;

-- Phase 5 purge sweep: pick trashed variants past their grace window.
CREATE INDEX IF NOT EXISTS assets_trash_purge_at_idx
  ON fonto.assets (trash_purge_at)
  WHERE trash_purge_at IS NOT NULL;
