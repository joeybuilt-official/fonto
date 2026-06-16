-- Intelligence Core — Phase 5.5 (ADR-0002): the elicitation question store.
--
-- fonto.elicitation_questions holds machine-generated questions whose answers
-- have the highest information value for the date/identity graph — e.g. "When
-- was <person> born?" or "Is this photo from <proposed month>?". The generator
-- ranks by info_value; the UI surfaces one (or a small batch) at a time and the
-- answer is written back as a human-origin fact / date confirm, which the Phase
-- 7 re-audit layer then propagates.
--
--   kind         — identify_cluster | birth_year | merge_clusters |
--                  confirm_fact | confirm_date  (taxonomy, ADR-0002)
--   target_type  — person | asset | cluster | fact
--   target_id    — subject of the question
--   prompt       — human-readable question
--   payload      — kind-specific context (proposed date, candidate ids, …)
--   info_value   — 0..1 ranking score (higher = ask sooner)
--   status       — open | answered | dismissed
--   answer       — recorded answer payload (NULL until answered)
--
-- Idempotent. Head before this = 0047_responsive_derivatives.

CREATE TABLE IF NOT EXISTS fonto.elicitation_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  kind         text NOT NULL,
  target_type  text NOT NULL,
  target_id    uuid,
  prompt       text NOT NULL,
  payload      jsonb,
  info_value   real NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open',
  answer       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz
);

-- One open question per (workspace, kind, target) — re-generation upserts
-- instead of piling duplicates. Partial unique index scoped to open rows so an
-- answered/dismissed question doesn't block a future re-ask.
CREATE UNIQUE INDEX IF NOT EXISTS elicitation_open_unique_idx
  ON fonto.elicitation_questions (workspace_id, kind, target_id)
  WHERE status = 'open';

-- Queue read path: top open questions for a workspace by info value.
CREATE INDEX IF NOT EXISTS elicitation_workspace_open_rank_idx
  ON fonto.elicitation_questions (workspace_id, status, info_value DESC);

ALTER TABLE fonto.elicitation_questions
  DROP CONSTRAINT IF EXISTS elicitation_kind_check;
ALTER TABLE fonto.elicitation_questions
  ADD CONSTRAINT elicitation_kind_check CHECK (kind IN (
    'identify_cluster', 'birth_year', 'merge_clusters', 'confirm_fact', 'confirm_date'
  ));

ALTER TABLE fonto.elicitation_questions
  DROP CONSTRAINT IF EXISTS elicitation_status_check;
ALTER TABLE fonto.elicitation_questions
  ADD CONSTRAINT elicitation_status_check CHECK (status IN ('open', 'answered', 'dismissed'));
