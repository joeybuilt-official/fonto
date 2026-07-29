-- SPDX-License-Identifier: MIT
-- Phase 6.7 — page count for scanned documents (PDFs) on fonto.assets.
--
-- The mobile ML Kit scanner uploads multi-page PDFs. The worker runs
-- `pdfinfo` during processAsset and records the page total here.
-- Optional everywhere so non-document rows leave it NULL (no migration
-- of existing assets needed).

ALTER TABLE fonto.assets
  ADD COLUMN page_count INTEGER;
