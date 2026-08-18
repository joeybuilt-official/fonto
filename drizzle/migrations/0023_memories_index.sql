-- SPDX-License-Identifier: MIT
-- Phase 5.3 — Memories ("On this day").
--
-- The memories feature answers "show me everything I captured on this
-- calendar day in prior years" (±N days fuzz, default 3). The query shape
-- is:
--
--   SELECT ... FROM fonto.assets
--   WHERE workspace_id = $1
--     AND lifecycle_state = 'active'
--     AND captured_at IS NOT NULL
--     AND EXTRACT(MONTH FROM captured_at) = $month
--     AND EXTRACT(DAY   FROM captured_at) BETWEEN $day - 3 AND $day + 3
--     AND EXTRACT(YEAR  FROM captured_at) < EXTRACT(YEAR FROM CURRENT_DATE)
--   ORDER BY captured_at DESC
--   LIMIT 200
--
-- Without an index the planner falls back to a seq scan + filter on the
-- whole assets table, which is unacceptable as the library grows. This
-- functional partial BTree lets the planner do an index-only range scan on
-- (workspace_id, month, day) and apply year/lifecycle as a residual.
--
-- The partial WHERE keeps the index small — assets that are trashed/
-- archived or have no capture date never appear in memories and shouldn't
-- bloat the index.
--
-- Additive + idempotent. Safe to re-run.
--
-- Migration coordination: previous slot 0020 (zero-shot classify). 0021 and
-- 0022 are reserved for parallel agents working on adjacent phases; this
-- one lands at 0023 per Phase 5 plan.

-- NOTE: Postgres requires index expressions to be IMMUTABLE. EXTRACT() and
-- to_char() on timestamptz are STABLE per official catalog (they technically
-- depend on session settings — `DateStyle`, `lc_time`, even though we don't
-- use those format codes). Wrap in an IMMUTABLE SQL function asserting on
-- our authority that this particular (UTC, 'MM-DD') combination is in fact
-- timezone- and locale-independent.
CREATE OR REPLACE FUNCTION fonto.captured_mmdd_utc(t timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT to_char(t AT TIME ZONE 'UTC', 'MM-DD') $$;

CREATE INDEX IF NOT EXISTS assets_workspace_captured_mmdd_idx
    ON fonto.assets (
        workspace_id,
        fonto.captured_mmdd_utc(captured_at)
    )
    WHERE lifecycle_state = 'active' AND captured_at IS NOT NULL;
