-- SPDX-License-Identifier: MIT
-- Migration 0040: per-workspace storage placement (storage-placement Track B,
-- Phase B2). See /workspace/.fonto-phased/adr/0001-storage-placement.md.
--
-- Adds the policy + per-asset override + per-asset local-copy marker. Additive
-- and defaulted so every existing row keeps today's behavior (r2_only, no local
-- copy). NO data move happens here — the write/backfill workers (B3/B5) populate
-- local_original_stored_at after a verified copy.
--
-- C4 (operator): only r2_only + mirror ship now; local_only is a later phase.
-- The CHECK still permits 'local_only' so the column is forward-compatible, but
-- no code path sets it yet.
-- C3 (operator): quota counts an asset ONCE regardless of backends — usage_bytes
-- is untouched here; NAS local-disk usage is a separate stat (B5/B6), not quota.

-- Workspace-level policy. Default r2_only = today's behavior.
ALTER TABLE "fonto"."workspaces"
  ADD COLUMN IF NOT EXISTS "storage_policy" text NOT NULL DEFAULT 'r2_only';

DO $$ BEGIN
  ALTER TABLE "fonto"."workspaces"
    ADD CONSTRAINT "workspaces_storage_policy_check"
    CHECK ("storage_policy" IN ('r2_only', 'mirror', 'local_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Per-asset override. NULL = inherit the workspace policy (the common case).
ALTER TABLE "fonto"."assets"
  ADD COLUMN IF NOT EXISTS "storage_policy_override" text;

DO $$ BEGIN
  ALTER TABLE "fonto"."assets"
    ADD CONSTRAINT "assets_storage_policy_override_check"
    CHECK ("storage_policy_override" IS NULL
           OR "storage_policy_override" IN ('r2_only', 'mirror', 'local_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Per-asset location state. NULL = the ORIGINAL has no verified local copy;
-- a timestamp = a size/etag-verified local copy of the original exists (set by
-- the mirror/backfill workers). Derivatives are never localized (C2: always R2),
-- so a single original-copy marker is the only per-asset location state needed
-- for the mirror-first scope. (local_only, when it ships, will add R2-absence
-- state of its own.)
ALTER TABLE "fonto"."assets"
  ADD COLUMN IF NOT EXISTS "local_original_stored_at" timestamptz;
