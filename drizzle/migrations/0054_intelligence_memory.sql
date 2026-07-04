-- Jex ADR-002: intelligence_memory table for the embedded Memory port.
-- Stores MemoryRecord rows; queried by cosine similarity via pgvector.
-- pgvector extension is already installed (fonto ADR-0010 HNSW face cluster).

CREATE TABLE IF NOT EXISTS fonto.intelligence_memory (
  id          uuid PRIMARY KEY,
  content     text NOT NULL,
  vector      vector(512) NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- HNSW index for fast cosine-distance queries.
CREATE INDEX IF NOT EXISTS intelligence_memory_vector_hnsw_idx
  ON fonto.intelligence_memory
  USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
