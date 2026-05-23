-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 4.4 — PaddleOCR PP-OCRv5 line-level bounding boxes.
--
-- `ocr_boxes` stores per-line OCR results so the lightbox can highlight
-- the source region for each detected text run. Shape:
--   [{ "text": "...", "bbox": [x, y, w, h], "confidence": 0.0..1.0 }, ...]
--
-- NULL means "no per-line data" (legacy LLM-OCR rows, or rows where OCR
-- hasn't run yet, or rows where PaddleOCR found no text). The companion
-- `ocr_text` column stays the source of truth for full-text search.
--
-- This migration is additive — safe to apply against an instance that's
-- still serving the legacy plexoVisionOcr path.

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS ocr_boxes jsonb;
