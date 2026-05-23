-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 5.5 — Manual stacks (RAW+JPEG, bursts, multiple edits).
--
-- A stack groups related assets where one is the "primary": the timeline
-- shows only the primary, clicking expands the rest in the lightbox.
-- Suggestion (lib/stacks/suggest.ts) is read-only — the user confirms
-- each suggested cluster before a stacks row is created.
--
-- This migration is additive:
--   1. `fonto.stacks` table.
--   2. `stack_id uuid` column on `fonto.assets` (nullable, soft FK).
--   3. Indexes:
--      - stacks(workspace_id), stacks(primary_asset_id)
--      - partial assets(workspace_id, stack_id) WHERE stack_id IS NOT NULL
--        (keeps the index small — most assets are unstacked at any time).
--
-- Soft-FK rationale: `primary_asset_id` and `assets.stack_id` are managed
-- entirely by the route handlers, mirroring `correspondent_id` /
-- `document_type_id`. Lifecycle:
--   - DELETE /api/v1/stacks/:id     un-stacks all members (stack_id = NULL),
--                                   then deletes the stack row.
--   - DELETE .../:id/assets/:assetId removes one member; promotes next-
--                                   oldest to primary if it was the primary,
--                                   or deletes the stack if empty.
--
-- Migration coordination: previous slot 0023 (memories_index). 0024 is
-- reserved for a parallel agent; this lands at 0025 per the Phase 5 plan
-- (Phase 5.5 = 0025).
--
-- Idempotent + additive. Safe to re-run.

CREATE TABLE IF NOT EXISTS fonto.stacks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    primary_asset_id uuid NOT NULL,
    name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stacks_workspace_id_idx
    ON fonto.stacks (workspace_id);

CREATE INDEX IF NOT EXISTS stacks_primary_asset_id_idx
    ON fonto.stacks (primary_asset_id);

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS stack_id uuid;

CREATE INDEX IF NOT EXISTS assets_workspace_stack_idx
    ON fonto.assets (workspace_id, stack_id)
    WHERE stack_id IS NOT NULL;
