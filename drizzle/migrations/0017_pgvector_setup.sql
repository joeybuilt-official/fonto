-- SPDX-License-Identifier: MIT
-- Phase 4.3: pgvector adoption + retire the FalkorDB mirror (ADR 0002).
--
-- This migration enables the pgvector extension on the target database and
-- adds the first vector-typed column on `fonto.assets` — `clip_vec` — which
-- Phase 4.2 will backfill with CLIP image embeddings (512-dim). pHash is
-- intentionally left as `bigint` for now; recasting it to `vector(64)` is a
-- separate later step per ADR 0002, after the CLIP path is in production.
--
-- Idempotency: every statement is `IF NOT EXISTS`-guarded so re-running the
-- migration on an already-set-up database is a no-op.
--
-- Operator notes:
--   * The `vector` extension must be installable on the DB. Cloudflare
--     Hyperdrive + postgres ship with it; bare Postgres needs
--     `apt-get install postgresql-NN-pgvector` on the host first.
--   * The HNSW index is created `WHERE clip_vec IS NOT NULL` so the index
--     stays small until the Phase 4.2 backfill runs — rows without an
--     embedding contribute nothing.
--   * On a large existing assets table the `CREATE INDEX ... USING hnsw`
--     can take a long time (HNSW build is O(N log N) with a sizeable
--     constant). pgvector's HNSW build is safe to run on a live table.

DO $pgvector$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION
        WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
            RAISE EXCEPTION
                'pgvector extension is not available on this database. '
                'Install the extension server-side (e.g. apt-get install '
                'postgresql-NN-pgvector) and grant CREATE on the database '
                'to the migration role, then re-run 0017. Original error: %',
                SQLERRM;
    END;
END
$pgvector$;

ALTER TABLE fonto.assets
    ADD COLUMN IF NOT EXISTS clip_vec vector(512);

CREATE INDEX IF NOT EXISTS assets_clip_vec_hnsw_idx
    ON fonto.assets
    USING hnsw (clip_vec vector_cosine_ops)
    WHERE clip_vec IS NOT NULL;
