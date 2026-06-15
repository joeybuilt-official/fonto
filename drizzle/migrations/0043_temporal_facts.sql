-- Intelligence Core — Phase 2 (ADR-0002): entity temporal anchors + family fact base.
--
-- Adds birth/death partial-date anchors to fonto.persons and creates the
-- fonto.temporal_facts table (residences, trips, events, recurring events,
-- life milestones). origin {human|inferred} is the tier gate — only `human`
-- facts ever propagate to a neighbouring image's date inference (ADR-0003).
--
-- Partial dates: a `*_date` column normalised to first-of-period + a
-- `*_precision` tag {year|month|day}. location_label is operator free-text,
-- NOT landmark recognition (absent in Plexo, ADR-0001 D5).
--
-- Idempotent. Head before this = 0042_asset_derived_from.

-- ── persons: temporal anchors ───────────────────────────────────────────────
ALTER TABLE fonto.persons ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE fonto.persons ADD COLUMN IF NOT EXISTS birth_precision text;
ALTER TABLE fonto.persons ADD COLUMN IF NOT EXISTS death_date date;
ALTER TABLE fonto.persons ADD COLUMN IF NOT EXISTS death_precision text;

DO $$ BEGIN
  ALTER TABLE fonto.persons
    ADD CONSTRAINT persons_birth_precision_check
    CHECK (birth_precision IS NULL OR birth_precision IN ('year', 'month', 'day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.persons
    ADD CONSTRAINT persons_death_precision_check
    CHECK (death_precision IS NULL OR death_precision IN ('year', 'month', 'day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- birth_date present => precision present, and vice-versa (keep the pair honest).
DO $$ BEGIN
  ALTER TABLE fonto.persons
    ADD CONSTRAINT persons_birth_pair_check
    CHECK ((birth_date IS NULL) = (birth_precision IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.persons
    ADD CONSTRAINT persons_death_pair_check
    CHECK ((death_date IS NULL) = (death_precision IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── temporal_facts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fonto.temporal_facts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL,
  type                 text NOT NULL,
  label                text NOT NULL,
  date_start           date,
  date_start_precision text,
  date_end             date,
  date_end_precision   text,
  recurrence           text,
  location_label       text,
  person_ids           uuid[] NOT NULL DEFAULT '{}'::uuid[],
  confidence           real NOT NULL DEFAULT 1,
  origin               text NOT NULL DEFAULT 'human',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE fonto.temporal_facts
    ADD CONSTRAINT temporal_facts_type_check
    CHECK (type IN ('residence', 'trip', 'event', 'recurring_event', 'life_milestone'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.temporal_facts
    ADD CONSTRAINT temporal_facts_origin_check
    CHECK (origin IN ('human', 'inferred'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.temporal_facts
    ADD CONSTRAINT temporal_facts_start_precision_check
    CHECK (date_start_precision IS NULL OR date_start_precision IN ('year', 'month', 'day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fonto.temporal_facts
    ADD CONSTRAINT temporal_facts_end_precision_check
    CHECK (date_end_precision IS NULL OR date_end_precision IN ('year', 'month', 'day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS temporal_facts_workspace_idx
  ON fonto.temporal_facts (workspace_id, type);

CREATE INDEX IF NOT EXISTS temporal_facts_person_ids_idx
  ON fonto.temporal_facts USING gin (person_ids);
