-- 0059_thumbnail_state.sql
--
-- Adds assets.thumbnail_state, mirroring the existing hls_state / ocr_state
-- columns so a permanently-failed thumbnail job is a queryable fact instead of
-- a record buried in BullMQ's Redis `failed` set.
--
-- Why this exists: prod accumulated 13,803 failed thumbnail jobs that were
-- invisible to both the app and /admin/jobs. Diagnosing them required
-- hand-querying Redis. hls_state and ocr_state were already first-class
-- columns; thumbnails had no equivalent.
--
-- States: idle | generating | ready | skipped | failed  (default 'idle')
--
-- Safety: additive only. ADD COLUMN with a CONSTANT default is metadata-only
-- on PostgreSQL 11+ (no full table rewrite), so this is fast even on a large
-- assets table and takes only a brief ACCESS EXCLUSIVE lock. Nothing is
-- dropped, narrowed, or backfilled. Idempotent per this repo's convention:
-- re-running is a no-op.
--
-- Hand-authored deliberately: `drizzle-kit generate` cannot produce an
-- incremental diff in this repo — drizzle.config.ts points `out` at ./drizzle
-- while the real history lives in ./drizzle/migrations with no
-- meta/_journal.json, so generation only ever emits a full CREATE-everything
-- baseline. Every migration 0001-0058 here is likewise hand-authored numbered
-- SQL; this file follows that established convention.

ALTER TABLE "fonto"."assets"
  ADD COLUMN IF NOT EXISTS "thumbnail_state" text NOT NULL DEFAULT 'idle';

CREATE INDEX IF NOT EXISTS "assets_thumbnail_state_idx"
  ON "fonto"."assets" ("thumbnail_state");
