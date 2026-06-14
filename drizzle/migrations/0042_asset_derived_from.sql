-- Task #32 — rotate / crop transform endpoint.
--
-- Adds `derived_from_asset_id` to fonto.assets so a "save-as-new" transform
-- (every crop, optionally a rotate) carries an authoritative pointer back to
-- the source asset. NULL = original ingest, not a derivative.
--
-- ON DELETE SET NULL: if the source is hard-deleted, derivatives become
-- standalone rows rather than cascade-deleting user-edited copies.
--
-- Idempotent. Head before this = 0041_scope_partition.

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS derived_from_asset_id uuid;

DO $$ BEGIN
  ALTER TABLE fonto.assets
    ADD CONSTRAINT assets_derived_from_asset_id_fk
    FOREIGN KEY (derived_from_asset_id)
    REFERENCES fonto.assets(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reverse lookup: "what derivatives did this asset spawn?"
-- Partial on derived rows so the BTree stays small (most assets are originals).
CREATE INDEX IF NOT EXISTS assets_derived_from_idx
    ON fonto.assets (derived_from_asset_id)
    WHERE derived_from_asset_id IS NOT NULL;
