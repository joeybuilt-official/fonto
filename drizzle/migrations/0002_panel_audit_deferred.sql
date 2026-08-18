-- SPDX-License-Identifier: MIT
-- Panel-audit deferred features: perceptual dedup (pHash), color search,
-- OCR-only search.

-- 64-bit pHash. Stored as bigint to preserve the high bit; signed range is
-- fine because we only ever XOR + popcount these values (Hamming distance).
ALTER TABLE fonto.assets
  ADD COLUMN IF NOT EXISTS phash       bigint,
  ADD COLUMN IF NOT EXISTS colors      jsonb,
  ADD COLUMN IF NOT EXISTS ocr_text    text,
  ADD COLUMN IF NOT EXISTS ocr_state   text NOT NULL DEFAULT 'pending';

-- Index pHash for ordered scans (we filter by hamming distance after a
-- workspace narrow-down, but keeping this indexed lets exact-equality
-- lookups stay cheap and helps `phash IS NOT NULL` filtering).
CREATE INDEX IF NOT EXISTS assets_phash_idx ON fonto.assets (phash);

-- Index ocr_state so the nightly backfill cron can pick up `pending` rows
-- without scanning the whole table.
CREATE INDEX IF NOT EXISTS assets_ocr_state_idx ON fonto.assets (ocr_state);

-- GIN index for full-text search on OCR-extracted text.
-- Matches the toggle in the search UI: `to_tsvector('english', ocr_text) @@ plainto_tsquery(...)`.
CREATE INDEX IF NOT EXISTS assets_ocr_text_fts_idx
  ON fonto.assets
  USING GIN (to_tsvector('english', coalesce(ocr_text, '')));
