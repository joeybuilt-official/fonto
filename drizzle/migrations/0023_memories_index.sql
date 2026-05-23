-- SPDX-License-Identifier: AGPL-3.0-only
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

-- NOTE: Postgres requires index expressions to be IMMUTABLE. `EXTRACT()` on
-- a `timestamp with time zone` is STABLE (depends on session timezone), not
-- IMMUTABLE — even though the underlying month/day values don't change for a
-- given absolute instant. `to_char(captured_at AT TIME ZONE 'UTC', 'MM-DD')`
-- is IMMUTABLE because the timezone is fixed. We index on that string and
-- the query layer formats `$month-$day` the same way for the lookup.
CREATE INDEX IF NOT EXISTS assets_workspace_captured_mmdd_idx
    ON fonto.assets (
        workspace_id,
        (to_char(captured_at AT TIME ZONE 'UTC', 'MM-DD'))
    )
    WHERE lifecycle_state = 'active' AND captured_at IS NOT NULL;
