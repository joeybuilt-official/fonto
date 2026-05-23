-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 5.1 — Face detection + ArcFace embedding + DBSCAN clustering.
--
-- This migration adds two new tables to `fonto`:
--
--   * face_instances — one row per detected face on an asset. Carries the
--     normalised bbox, ArcFace 512-dim L2-normalised embedding, detection
--     confidence, and an optional FK to a `persons` cluster.
--   * persons — one row per clustered identity. Built by the DBSCAN clusterer
--     in `lib/faces/cluster.ts`. Name + cover face are user-edited via the
--     People page UI.
--
-- Dependencies:
--   * pgvector extension — created in 0017 (Phase 4.3). Re-asserted here as
--     a safety net so this migration is self-contained on a fresh DB.
--
-- Idempotency: every statement is `IF NOT EXISTS`-guarded so re-running the
-- migration on an already-set-up database is a no-op. The HNSW index is
-- `WHERE embedding IS NOT NULL` so unbackfilled rows don't bloat it.
--
-- Operator notes:
--   * On a populated assets table the face detect/embed worker will be the
--     bottleneck — ArcFace embeds run on the Plexo vision service (Phase
--     4.1), not in-DB. Migration itself is fast (empty tables).
--   * HNSW build on `face_instances.embedding` is partial (skips NULL rows),
--     so the index stays cheap until the worker has backfilled embeddings.

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
                'to the migration role, then re-run 0021. Original error: %',
                SQLERRM;
    END;
END
$pgvector$;

-- Persons table first (face_instances FKs to it via personId).
CREATE TABLE IF NOT EXISTS fonto.persons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    -- User-assigned display name. NULL = unnamed cluster (UI shows
    -- "Unnamed person" + cover thumbnail).
    name text,
    -- The face the user picked (or the cluster centroid we picked at create
    -- time) as the avatar. NULL means "fall back to the first face in the
    -- cluster" at render time.
    cover_face_id uuid,
    -- Hidden from the People page grid (false positives, strangers, kids
    -- the user doesn't want surfaced). Faces stay attached to the person;
    -- only the cluster card is suppressed.
    hidden boolean NOT NULL DEFAULT false,
    -- Denormalised count of face_instances pointing at this person.
    -- Kept in sync by the clusterer + merge/split route handlers.
    instance_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- People page grid: list workspace persons (excluding hidden) ordered by
-- instance count desc.
CREATE INDEX IF NOT EXISTS persons_workspace_visible_idx
    ON fonto.persons (workspace_id, hidden, instance_count DESC);

CREATE TABLE IF NOT EXISTS fonto.face_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    -- Normalised bounding box (0..1) — { x, y, w, h }. Stored as jsonb for
    -- forward-compatibility (future: landmarks array, pose vector).
    bbox jsonb NOT NULL,
    -- Detection confidence from RetinaFace. 0..1; we keep all detections,
    -- the UI filters low-confidence ones.
    confidence real NOT NULL,
    -- ArcFace 512-dim embedding. Unit-norm so cosine distance is 1 - dot(a,b).
    -- NULL between detect and embed steps (the worker writes detect rows
    -- first, then fills in embeddings as the embed call returns).
    embedding vector(512),
    -- DBSCAN cluster assignment. NULL means the face hasn't been clustered
    -- yet, or it landed in DBSCAN noise (no cluster met minPts).
    person_id uuid,
    -- User-hidden flag (false positives, strangers). Hidden faces are
    -- excluded from clustering inputs on the next run.
    hidden boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- People-page detail: faces belonging to a person, scoped to workspace.
CREATE INDEX IF NOT EXISTS face_instances_workspace_person_idx
    ON fonto.face_instances (workspace_id, person_id);

-- "Show faces on this asset" — used by the asset lightbox.
CREATE INDEX IF NOT EXISTS face_instances_asset_idx
    ON fonto.face_instances (asset_id);

-- Partial HNSW: clustering + "other suggested faces" sidebar both run NN
-- over the embedding. WHERE clause keeps the index small until embeddings
-- backfill.
CREATE INDEX IF NOT EXISTS face_instances_embedding_hnsw_idx
    ON fonto.face_instances
    USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;
