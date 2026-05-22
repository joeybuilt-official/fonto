-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 0 item 0.1: BullMQ queue + worker — observability columns.
--
-- Records the last processing error message and a per-asset attempt count
-- so the admin UI and operator queries can see why an asset stalled. The
-- BullMQ worker writes processing_error on failure and clears it on
-- success; processing_attempts is incremented every time the worker
-- picks the job up.

ALTER TABLE fonto.assets
  ADD COLUMN IF NOT EXISTS processing_error    text,
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0;
