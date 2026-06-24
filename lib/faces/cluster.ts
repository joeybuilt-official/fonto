// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — DBSCAN clustering over `fonto.face_instances` to materialise
// `fonto.persons` rows.
//
// Inputs
// ------
// Every non-hidden face_instance for the workspace with a populated
// embedding. The HNSW pgvector index in 0021 makes near-neighbour lookups
// cheap, but for the initial clusterer we load everything in-memory — at
// realistic personal-archive sizes (~10k–100k faces) the O(N²) DBSCAN scan
// is still measured in seconds, not minutes, and avoids round-trip
// amplification.
//
// Algorithm
// ---------
// Cosine-distance DBSCAN. Embeddings are L2-normalised by the embed step,
// so cosine distance is `1 - dot(a, b)` and falls in [0, 2]. Defaults:
//   - eps    = 0.32   (≈ "moderately similar" in ArcFace space)
//   - minPts = 5      (fewer than 5 similar faces is noise by default —
//                      avoids flooding People with coincidental look-alike
//                      trios; one-off strangers never get a card)
//
// Idempotency / hand-edit preservation
// ------------------------------------
// Running the clusterer twice in a row with no new faces is a no-op:
//
//   1. Faces already attached to a (non-deleted) person stay attached;
//      they're SKIPPED as cluster seeds so we never "move" them.
//   2. When a fresh cluster shares >=50% of its members with one existing
//      named person, the new members attach to that person rather than
//      spawning an anonymous duplicate.
//   3. Pure-noise faces have person_id reset to NULL (so a face that drops
//      out of a cluster after a merge gets unattached).
//   4. Person `instance_count` is recomputed from face_instances at the
//      end of every run; never drifts.
//
// Run cost on the hot paths
// -------------------------
// The /api/v1/faces/cluster route triggers this synchronously for the
// caller's workspace. For multi-tenant deploys with very large workspaces
// we should move it to a BullMQ job; until then the route's
// `requireWorkspaceAccess('owner')` gate (admin/owner only) is the rate
// limit.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { neighborsViaGPU } from "@/lib/plexo-vision";

/**
 * Threshold above which we delegate neighbour computation to the
 * plexo-vision GPU endpoint. Below this, HTTP round-trip overhead
 * dominates the O(N²) JS scan — the in-process path wins.
 */
const GPU_CLUSTER_MIN_N = 2000;
// Above this, the O(N²) in-process JS DBSCAN pegs the worker's single thread and
// starves asset processing — so it's only a fallback for modest sets; larger
// sets that can't reach the GPU skip the pass rather than melt down.
const JS_DBSCAN_MAX_N = 20000;

export interface ClusterOpts {
  /** Cosine-distance threshold; 0 = identical, 2 = opposite. Default 0.32. */
  eps?: number;
  /** Minimum cluster size for a point to be a "core". Default 3. */
  minPts?: number;
}

export interface ClusterStats {
  /** New person rows created this run. */
  created: number;
  /** Existing persons re-used (or whose members changed). */
  updated: number;
  /** Faces that landed in DBSCAN noise (no cluster met minPts). */
  noise: number;
}

interface FaceRow {
  id: string;
  embedding: number[];
  personId: string | null;
  confidence: number | null;
}

interface FaceIdRow {
  id: string;
  personId: string | null;
}

interface PersonRow {
  id: string;
  name: string | null;
}

/**
 * Cosine distance between two L2-normalised vectors. We don't re-normalise
 * here — the embed pipeline (ArcFace) emits unit-norm vectors. Re-norming
 * would defeat the dot-product fast path.
 */
function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  // Clamp to [0, 2] — floating-point noise can push slightly past the
  // theoretical bounds for near-identical vectors.
  return Math.max(0, Math.min(2, 1 - dot));
}

/**
 * Vanilla DBSCAN over the supplied points. Returns cluster ids per point
 * (`-1` for noise, `0..k-1` for assignments). `eps` is the distance
 * threshold; `minPts` is the core-point minimum.
 *
 * O(N²) — fine for workspace-scale (≤ ~100k) face counts. If we ever push
 * past that we should swap to an HNSW-backed neighbour query.
 */
function dbscan(
  points: number[][],
  eps: number,
  minPts: number
): number[] {
  const n = points.length;
  const labels = new Array<number>(n).fill(-2); // -2 = unvisited, -1 = noise
  let cluster = -1;

  // Pre-compute neighbours so the inner loop is fast.
  const neighbours = (idx: number): number[] => {
    const out: number[] = [];
    const a = points[idx];
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      if (cosineDistance(a, points[j]) <= eps) out.push(j);
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = neighbours(i);
    if (nb.length + 1 < minPts) {
      labels[i] = -1;
      continue;
    }
    cluster++;
    labels[i] = cluster;
    const seeds = [...nb];
    while (seeds.length > 0) {
      const q = seeds.shift()!;
      if (labels[q] === -1) labels[q] = cluster;
      if (labels[q] !== -2) continue;
      labels[q] = cluster;
      const qn = neighbours(q);
      if (qn.length + 1 >= minPts) {
        for (const x of qn) if (!seeds.includes(x)) seeds.push(x);
      }
    }
  }
  return labels;
}

/**
 * DBSCAN cluster assignment from a pre-computed neighbour graph. The
 * plexo-vision GPU endpoint returns (edges, deg) over the same eps the
 * caller would have used in-process; this function maps that to the
 * familiar `labels[]` shape (`-1` = noise, `0..k-1` = cluster id) without
 * ever touching the embedding vectors.
 *
 *   - Core points: `deg[i] >= minPts - 1` (consistent with the in-process
 *     `dbscan` above, which counts the point itself toward minPts).
 *   - Union-find over edges with BOTH endpoints core gives core clusters.
 *   - Border points (non-core but with ≥1 core neighbour) attach to the
 *     cluster of the FIRST core neighbour encountered when iterating
 *     `edges` in the order the server returned them — deterministic given
 *     a stable edge list.
 *   - Noise = non-core with no core neighbour.
 */
export function dbscanFromEdges(
  edges: ReadonlyArray<readonly [number, number]>,
  deg: ReadonlyArray<number>,
  n: number,
  minPts: number
): number[] {
  const core = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    core[i] = (deg[i] ?? 0) >= minPts - 1;
  }

  // Union-find over core points only.
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // Path compression.
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur];
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const e of edges) {
    const a = e[0];
    const b = e[1];
    if (core[a] && core[b]) union(a, b);
  }

  // Assign dense cluster ids to each core root.
  const labels = new Array<number>(n).fill(-1);
  const rootToCluster = new Map<number, number>();
  let nextCluster = 0;
  for (let i = 0; i < n; i++) {
    if (!core[i]) continue;
    const r = find(i);
    let cid = rootToCluster.get(r);
    if (cid === undefined) {
      cid = nextCluster++;
      rootToCluster.set(r, cid);
    }
    labels[i] = cid;
  }

  // Border points: walk edges in given order, first core neighbour wins.
  for (const e of edges) {
    const a = e[0];
    const b = e[1];
    if (core[a] && !core[b] && labels[b] === -1) labels[b] = labels[a];
    else if (core[b] && !core[a] && labels[a] === -1) labels[a] = labels[b];
  }

  return labels;
}

/**
 * Cluster a workspace's face embeddings into `persons` rows.
 *
 * Returns counts of newly created persons, updated/reused persons, and
 * noise (unclustered) faces. Safe to call from the API route on a small
 * workspace; should be queued for very large ones.
 */
export async function clusterWorkspaceFaces(
  workspaceId: string,
  opts: ClusterOpts = {}
): Promise<ClusterStats> {
  const log = logger.child({ component: "face-cluster", workspaceId });
  const eps = opts.eps ?? 0.32;
  // minPts 5: a person card needs ≥5 similar faces. At minPts 3 the People
  // grid flooded with hundreds of coincidental 3-face look-alike trios; 5
  // keeps recurring people while dropping spurious groups into noise (their
  // faces stay attached to assets + searchable — they just get no card).
  const minPts = opts.minPts ?? 5;
  // Drop detector noise below this confidence floor before clustering.
  // SCRFD will report borderline faces around 0.40-0.55 that turn out to be
  // hair, brick walls, fabric folds, etc. — they used to cluster together
  // (similar embeddings on similar non-faces) into bogus People cards. The
  // named-clusters' confidence floor sits at ~0.75, so 0.55 leaves a generous
  // margin while excising the false positives the user complained about.
  const minConfidence = Number(process.env.FACE_CLUSTER_MIN_CONFIDENCE ?? "0.55");

  // Pull every non-hidden, embedded face for the workspace.
  const rows = (await db
    .select({
      id: schema.faceInstances.id,
      embedding: schema.faceInstances.embedding,
      personId: schema.faceInstances.personId,
      confidence: schema.faceInstances.confidence,
    })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.workspaceId, workspaceId),
        eq(schema.faceInstances.hidden, false),
        isNotNull(schema.faceInstances.embedding),
        sql`${schema.faceInstances.confidence} >= ${minConfidence}`
      )
    )) as FaceRow[];

  log.info({ faceCount: rows.length, eps, minPts }, "loaded faces");
  if (rows.length === 0) {
    return { created: 0, updated: 0, noise: 0 };
  }

  // Drop rows whose embedding read back malformed. Defensive — the embed
  // step should guarantee well-formed 512-dim vectors, but a partial
  // migration / hand-edit could violate that.
  let usable: FaceRow[] = rows.filter(
    (r) => Array.isArray(r.embedding) && r.embedding.length > 0
  );

  // Single-pass cap. The GPU edge-builder (plexo-vision /v1/faces/cluster)
  // rejects N > VISION_CLUSTER_MAX_N (50k) and bodies > 512MB, and a JSON body
  // for ~90k+ faces exceeds V8's ~512MB max string length — which used to throw
  // "Invalid string length" and kill the whole pass SILENTLY (logged warn, no
  // clustering) on large libraries. Until the endpoint accepts a chunked/binary
  // payload we cluster the highest-confidence MAX_N faces: the excised tail is
  // the lowest-confidence detections, and every excluded face stays attached +
  // searchable — it just doesn't seed a person card this pass. PARTIAL coverage
  // is logged loudly so it's never mistaken for "everything clustered".
  const MAX_CLUSTER_N = Number(process.env.FACE_CLUSTER_MAX_N ?? "50000");
  let partialDropped = 0;
  if (usable.length > MAX_CLUSTER_N) {
    partialDropped = usable.length - MAX_CLUSTER_N;
    usable = [...usable]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, MAX_CLUSTER_N);
    log.warn(
      { total: usable.length + partialDropped, clustered: MAX_CLUSTER_N, dropped: partialDropped },
      "face set exceeds single-pass cap — clustering highest-confidence subset only (PARTIAL); excluded faces stay searchable but ungrouped"
    );
  }

  const points = usable.map((r) => r.embedding);
  // GPU path when the library is big enough for HTTP overhead to pay off.
  // Falls back to in-process JS on endpoint failure or when explicitly
  // disabled via FACE_CLUSTER_GPU_DISABLED=1 (escape hatch for incidents).
  let labels: number[];
  if (
    points.length >= GPU_CLUSTER_MIN_N &&
    process.env.FACE_CLUSTER_GPU_DISABLED !== "1"
  ) {
    const gpu = await neighborsViaGPU(points, eps, minPts);
    if (gpu) {
      labels = dbscanFromEdges(gpu.edges, gpu.deg, points.length, minPts);
      log.info({ count: points.length, ep: "cuda" }, "cluster via gpu");
    } else if (points.length <= JS_DBSCAN_MAX_N) {
      labels = dbscan(points, eps, minPts);
      log.info(
        { count: points.length, ep: "cpu-fallback" },
        "cluster via cpu"
      );
    } else {
      // GPU unreachable AND too many faces for the O(N²) JS DBSCAN (it pegs the
      // worker's single thread + starves asset processing). Skip this pass
      // rather than melt down; the next debounced trigger retries the GPU.
      log.warn(
        { count: points.length, ep: "skipped" },
        "GPU edge-builder unavailable and face set too large for JS fallback — skipping cluster pass"
      );
      return { created: 0, updated: 0, noise: 0 };
    }
  } else {
    labels = dbscan(points, eps, minPts);
  }

  const { created, updated, noise, clusterCount } = await applyClusterLabels(
    workspaceId,
    usable,
    labels
  );
  log.info({ created, updated, noise, clusters: clusterCount }, "clustering complete");
  return { created, updated, noise };
}

/**
 * Apply DBSCAN labels to the `persons` / `face_instances` tables.
 * Shared by both the embedding-based (GPU/JS) and HNSW clustering paths.
 * - Existing named persons are never merged or renamed.
 * - Anonymous persons absorb new members from matching clusters.
 * - Noise faces lose their anonymous person assignment.
 * - `instance_count` is recomputed from ground truth at the end.
 */
async function applyClusterLabels(
  workspaceId: string,
  faceRows: FaceIdRow[],
  labels: number[]
): Promise<{ created: number; updated: number; noise: number; clusterCount: number }> {
  const clusters = new Map<number, string[]>();
  let noise = 0;
  for (let i = 0; i < faceRows.length; i++) {
    const label = labels[i];
    if (label === -1) { noise++; continue; }
    let list = clusters.get(label);
    if (!list) { list = []; clusters.set(label, list); }
    list.push(faceRows[i].id);
  }

  const existingPersons = await db
    .select({ id: schema.persons.id, name: schema.persons.name })
    .from(schema.persons)
    .where(eq(schema.persons.workspaceId, workspaceId));
  const existingPersonById = new Map<string, PersonRow>(
    existingPersons.map((p) => [p.id, p])
  );

  const facePersonNow = new Map<string, string>();
  for (const r of faceRows) {
    if (r.personId && existingPersonById.has(r.personId)) {
      facePersonNow.set(r.id, r.personId);
    }
  }

  let created = 0;
  let updated = 0;

  for (const [, faceIds] of clusters) {
    const tally = new Map<string, number>();
    for (const fid of faceIds) {
      const pid = facePersonNow.get(fid);
      if (pid) tally.set(pid, (tally.get(pid) ?? 0) + 1);
    }

    let attachTo: string | null = null;
    let bestCount = 0;
    for (const [pid, count] of tally) {
      if (count > bestCount) { bestCount = count; attachTo = pid; }
    }
    if (attachTo && bestCount * 2 < faceIds.length) {
      const namedHits = Array.from(tally.entries()).filter(
        ([pid]) => (existingPersonById.get(pid)?.name ?? null) !== null
      );
      if (namedHits.length === 1) {
        attachTo = namedHits[0][0];
      } else if (namedHits.length === 0) {
        attachTo = null;
      } else {
        namedHits.sort((a, b) => b[1] - a[1]);
        attachTo = namedHits[0][0];
      }
    }

    if (attachTo) {
      updated++;
      const toMove: string[] = [];
      for (const fid of faceIds) {
        const currentPid = facePersonNow.get(fid);
        if (currentPid === attachTo) continue;
        if (currentPid) {
          const cur = existingPersonById.get(currentPid);
          if (cur && cur.name !== null) continue;
        }
        toMove.push(fid);
      }
      if (toMove.length > 0) {
        await db
          .update(schema.faceInstances)
          .set({ personId: attachTo })
          .where(inArray(schema.faceInstances.id, toMove));
      }
    } else {
      const facesWithoutNamedPerson: string[] = [];
      for (const fid of faceIds) {
        const currentPid = facePersonNow.get(fid);
        if (!currentPid) { facesWithoutNamedPerson.push(fid); continue; }
        const cur = existingPersonById.get(currentPid);
        if (cur && cur.name === null) facesWithoutNamedPerson.push(fid);
      }
      if (facesWithoutNamedPerson.length === 0) continue;

      const [newPerson] = await db
        .insert(schema.persons)
        .values({ workspaceId, name: null, coverFaceId: facesWithoutNamedPerson[0], instanceCount: 0 })
        .returning({ id: schema.persons.id });
      created++;
      await db
        .update(schema.faceInstances)
        .set({ personId: newPerson.id })
        .where(inArray(schema.faceInstances.id, facesWithoutNamedPerson));
    }
  }

  const noiseFaceIds: string[] = [];
  for (let i = 0; i < faceRows.length; i++) {
    if (labels[i] !== -1) continue;
    const r = faceRows[i];
    if (!r.personId) continue;
    const p = existingPersonById.get(r.personId);
    if (p && p.name !== null) continue;
    noiseFaceIds.push(r.id);
  }
  if (noiseFaceIds.length > 0) {
    await db
      .update(schema.faceInstances)
      .set({ personId: null })
      .where(inArray(schema.faceInstances.id, noiseFaceIds));
  }

  await db.execute(sql`
    UPDATE fonto.persons p
    SET instance_count = COALESCE(c.cnt, 0), updated_at = now()
    FROM (
      SELECT person_id, COUNT(*)::int AS cnt
      FROM fonto.face_instances
      WHERE workspace_id = ${workspaceId} AND person_id IS NOT NULL
      GROUP BY person_id
    ) c
    WHERE p.workspace_id = ${workspaceId} AND p.id = c.person_id
  `);
  await db.execute(sql`
    UPDATE fonto.persons p
    SET instance_count = 0, updated_at = now()
    WHERE p.workspace_id = ${workspaceId}
      AND NOT EXISTS (
        SELECT 1 FROM fonto.face_instances f WHERE f.person_id = p.id
      )
  `);

  await recomputeCoverFacesForWorkspace(workspaceId);

  return { created, updated, noise, clusterCount: clusters.size };
}

// ---------- HNSW-backed full-library batch clustering (M15 closeout) ----------

const HNSW_BATCH_SIZE = 1000;
const HNSW_NEIGHBOR_LIMIT = 100;

/**
 * Build a DBSCAN edge graph for `faceIds` entirely inside PostgreSQL, using
 * the HNSW pgvector index (migration 0021). No embedding vectors are loaded
 * into Node memory — the distance computation stays DB-side.
 *
 * Returns the same {edges, deg} shape as neighborsViaGPU, suitable for
 * dbscanFromEdges. Edges are deduplicated (each pair appears once).
 */
async function buildEdgesViaHNSW(
  workspaceId: string,
  faceIds: string[],
  idToIdx: Map<string, number>,
  eps: number,
  minConfidence: number
): Promise<{ edges: ReadonlyArray<readonly [number, number]>; deg: ReadonlyArray<number> }> {
  const n = faceIds.length;
  const deg = new Array<number>(n).fill(0);
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];

  for (let offset = 0; offset < n; offset += HNSW_BATCH_SIZE) {
    const batch = faceIds.slice(offset, offset + HNSW_BATCH_SIZE);
    const rawRows = await db.execute(sql`
      SELECT src.id AS source_id, n.id AS neighbor_id
      FROM fonto.face_instances src
      CROSS JOIN LATERAL (
        SELECT fi.id
        FROM fonto.face_instances fi
        WHERE fi.workspace_id = ${workspaceId}
          AND fi.hidden = false
          AND fi.confidence >= ${minConfidence}
          AND fi.id != src.id
          AND (src.embedding <=> fi.embedding) <= ${eps}
        ORDER BY src.embedding <=> fi.embedding
        LIMIT ${HNSW_NEIGHBOR_LIMIT}
      ) n
      WHERE src.id = ANY(${batch}::uuid[])
        AND src.workspace_id = ${workspaceId}
        AND src.hidden = false
        AND src.confidence >= ${minConfidence}
    `);
    const rows = rawRows as unknown as Array<{ source_id: string; neighbor_id: string }>;

    for (const row of rows) {
      const a = idToIdx.get(row.source_id);
      const b = idToIdx.get(row.neighbor_id);
      if (a === undefined || b === undefined) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([a, b]);
        deg[a]++;
        deg[b]++;
      }
    }
  }

  return { edges, deg };
}

/**
 * Full-library face clustering via pgvector HNSW — no 50k cap, no embedding
 * vectors loaded into Node memory. Intended for the nightly cron job.
 *
 * Uses the same DBSCAN parameters (eps, minPts) and DB-update logic as
 * clusterWorkspaceFaces. Safe to call concurrently for different workspaces.
 */
export async function clusterWorkspaceFacesHNSW(
  workspaceId: string,
  opts: ClusterOpts = {}
): Promise<ClusterStats> {
  const log = logger.child({ component: "face-cluster-hnsw", workspaceId });
  const eps = opts.eps ?? 0.32;
  const minPts = opts.minPts ?? 5;
  const minConfidence = Number(process.env.FACE_CLUSTER_MIN_CONFIDENCE ?? "0.55");

  const rows = await db
    .select({
      id: schema.faceInstances.id,
      personId: schema.faceInstances.personId,
    })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.workspaceId, workspaceId),
        eq(schema.faceInstances.hidden, false),
        isNotNull(schema.faceInstances.embedding),
        sql`${schema.faceInstances.confidence} >= ${minConfidence}`
      )
    ) as FaceIdRow[];

  log.info({ faceCount: rows.length, eps, minPts }, "hnsw-cluster: loaded face ids");
  if (rows.length === 0) return { created: 0, updated: 0, noise: 0 };

  const faceIds = rows.map((r) => r.id);
  const idToIdx = new Map(faceIds.map((id, i) => [id, i]));

  const graph = await buildEdgesViaHNSW(workspaceId, faceIds, idToIdx, eps, minConfidence);
  const labels = dbscanFromEdges(graph.edges, graph.deg, faceIds.length, minPts);

  const { created, updated, noise, clusterCount } = await applyClusterLabels(
    workspaceId,
    rows,
    labels
  );
  log.info({ created, updated, noise, clusters: clusterCount, faces: rows.length }, "hnsw-cluster complete");
  return { created, updated, noise };
}

/**
 * Recompute `persons.cover_face_id` for every person in the workspace whose
 * face_instances exist. The chosen face is the highest-quality unhidden
 * face: confidence × bbox area, tie-break newer-photo-wins. Idempotent —
 * running it twice on identical data produces the same result.
 *
 * Called inline at the end of clusterWorkspaceFaces() so the People grid
 * reflects current truth right after any cluster pass. Also safe to
 * trigger as an admin re-cover sweep.
 */
export async function recomputeCoverFacesForWorkspace(
  workspaceId: string
): Promise<void> {
  await db.execute(sql`
    WITH best_face AS (
      SELECT DISTINCT ON (fi.person_id)
        fi.person_id,
        fi.id AS face_id
      FROM fonto.face_instances fi
      WHERE fi.workspace_id = ${workspaceId}
        AND fi.person_id IS NOT NULL
        AND fi.hidden = false
        AND fi.confidence IS NOT NULL
        AND fi.bbox IS NOT NULL
      ORDER BY
        fi.person_id,
        fi.confidence * COALESCE(
          (fi.bbox->>'w')::real * (fi.bbox->>'h')::real, 0
        ) DESC,
        fi.created_at DESC
    )
    UPDATE fonto.persons p
    SET cover_face_id = bf.face_id, updated_at = now()
    FROM best_face bf
    WHERE p.id = bf.person_id
      AND p.workspace_id = ${workspaceId}
      AND (p.cover_face_id IS DISTINCT FROM bf.face_id);
  `);
}
