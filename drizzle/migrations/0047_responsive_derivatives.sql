-- T2.3 fonto-perf-audit 2026-06-15
-- Add responsive thumbnail tiers (512px, 1024px) and AVIF variants of every
-- thumbnail size + the 1080 preview. Existing thumbnail_key (256@webp) and
-- preview_key (1080@webp) stay as legacy fallbacks.
-- Reversible: ALTER TABLE fonto.assets DROP COLUMN <each>;
-- Storage cost per asset ≈ 6 new R2 objects, total derivatives ~180-220 KB
-- vs ~108 KB currently. R2 cost is pennies.
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS thumbnail_256_avif_key text;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS thumbnail_512_webp_key text;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS thumbnail_512_avif_key text;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS thumbnail_1024_webp_key text;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS thumbnail_1024_avif_key text;
ALTER TABLE fonto.assets ADD COLUMN IF NOT EXISTS preview_avif_key text;
