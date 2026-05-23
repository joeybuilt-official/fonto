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
//   - minPts = 3      (a singleton face or a pair is noise by default —
//                      avoids surfacing one-off strangers)
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
  const minPts = opts.minPts ?? 3;

  // Pull every non-hidden, embedded face for the workspace.
  const rows = (await db
    .select({
      id: schema.faceInstances.id,
      embedding: schema.faceInstances.embedding,
      personId: schema.faceInstances.personId,
    })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.workspaceId, workspaceId),
        eq(schema.faceInstances.hidden, false),
        isNotNull(schema.faceInstances.embedding)
      )
    )) as FaceRow[];

  log.info({ faceCount: rows.length, eps, minPts }, "loaded faces");
  if (rows.length === 0) {
    return { created: 0, updated: 0, noise: 0 };
  }

  // Drop rows whose embedding read back malformed. Defensive — the embed
  // step should guarantee well-formed 512-dim vectors, but a partial
  // migration / hand-edit could violate that.
  const usable: FaceRow[] = rows.filter(
    (r) => Array.isArray(r.embedding) && r.embedding.length > 0
  );

  const points = usable.map((r) => r.embedding);
  const labels = dbscan(points, eps, minPts);

  // Group face ids by cluster label.
  const clusters = new Map<number, string[]>();
  let noise = 0;
  for (let i = 0; i < usable.length; i++) {
    const label = labels[i];
    if (label === -1) {
      noise++;
      continue;
    }
    let list = clusters.get(label);
    if (!list) {
      list = [];
      clusters.set(label, list);
    }
    list.push(usable[i].id);
  }

  // Look up existing person rows so we can preserve names + merge.
  const existingPersons = await db
    .select({ id: schema.persons.id, name: schema.persons.name })
    .from(schema.persons)
    .where(eq(schema.persons.workspaceId, workspaceId));
  const existingPersonById = new Map<string, PersonRow>(
    existingPersons.map((p) => [p.id, p])
  );

  // Map current face -> person assignment so we can decide whether to
  // re-use an existing cluster.
  const facePersonNow = new Map<string, string>();
  for (const r of usable) {
    if (r.personId && existingPersonById.has(r.personId)) {
      facePersonNow.set(r.id, r.personId);
    }
  }

  let created = 0;
  let updated = 0;

  for (const [, faceIds] of clusters) {
    // Tally which existing persons these face members already belong to.
    const tally = new Map<string, number>();
    for (const fid of faceIds) {
      const pid = facePersonNow.get(fid);
      if (pid) tally.set(pid, (tally.get(pid) ?? 0) + 1);
    }

    // Pick the top-tally person — but only if they cover >=50% of the
    // cluster. This protects merge/named-person identity: a small fresh
    // cluster shouldn't be absorbed by a much larger named person.
    let attachTo: string | null = null;
    let bestCount = 0;
    for (const [pid, count] of tally) {
      if (count > bestCount) {
        bestCount = count;
        attachTo = pid;
      }
    }
    if (attachTo && bestCount * 2 < faceIds.length) {
      // Prefer named persons even at a smaller share — if the top tally
      // happens to be a named person and any other tally exists for a
      // named person, the user's hand-labelled identity wins.
      const namedHits = Array.from(tally.entries()).filter(
        ([pid]) => (existingPersonById.get(pid)?.name ?? null) !== null
      );
      if (namedHits.length === 1) {
        attachTo = namedHits[0][0];
      } else if (namedHits.length === 0) {
        attachTo = null;
      } else {
        // Multiple named persons in one cluster — don't auto-merge; pick
        // the largest named tally so faces glom onto the dominant identity
        // and the rest stay where they are.
        namedHits.sort((a, b) => b[1] - a[1]);
        attachTo = namedHits[0][0];
      }
    }

    if (attachTo) {
      updated++;
      // Attach any faces in the cluster that aren't already pointing here
      // (and aren't already attached to a *different* named person — those
      // we leave alone to preserve hand edits).
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
      // No suitable existing person — only create a new one if none of
      // these faces already belong to a named person (preserve hand edits).
      const facesWithoutNamedPerson: string[] = [];
      for (const fid of faceIds) {
        const currentPid = facePersonNow.get(fid);
        if (!currentPid) {
          facesWithoutNamedPerson.push(fid);
          continue;
        }
        const cur = existingPersonById.get(currentPid);
        if (cur && cur.name === null) {
          // Anonymous existing person — re-clustering can move members.
          facesWithoutNamedPerson.push(fid);
        }
        // Named existing person — preserve, skip.
      }
      if (facesWithoutNamedPerson.length === 0) continue;

      const [newPerson] = await db
        .insert(schema.persons)
        .values({
          workspaceId,
          name: null,
          coverFaceId: facesWithoutNamedPerson[0],
          instanceCount: 0,
        })
        .returning({ id: schema.persons.id });
      created++;
      await db
        .update(schema.faceInstances)
        .set({ personId: newPerson.id })
        .where(inArray(schema.faceInstances.id, facesWithoutNamedPerson));
    }
  }

  // Noise: detach faces that landed in noise but had a (non-named) person.
  // Named persons keep their members regardless — the user labelled them.
  const noiseFaceIds: string[] = [];
  for (let i = 0; i < usable.length; i++) {
    if (labels[i] !== -1) continue;
    const r = usable[i];
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

  // Recompute instance_count for every person in the workspace from the
  // ground truth (face_instances). Cheap; a single grouped subquery.
  await db.execute(sql`
    UPDATE fonto.persons p
    SET instance_count = COALESCE(c.cnt, 0),
        updated_at = now()
    FROM (
      SELECT person_id, COUNT(*)::int AS cnt
      FROM fonto.face_instances
      WHERE workspace_id = ${workspaceId}
        AND person_id IS NOT NULL
      GROUP BY person_id
    ) c
    WHERE p.workspace_id = ${workspaceId}
      AND p.id = c.person_id
  `);
  // Zero out any persons no longer pointed-at (their faces were all
  // detached). We don't delete the row — keeps the user's name + hidden
  // edits intact if they later attach faces back.
  await db.execute(sql`
    UPDATE fonto.persons p
    SET instance_count = 0,
        updated_at = now()
    WHERE p.workspace_id = ${workspaceId}
      AND NOT EXISTS (
        SELECT 1 FROM fonto.face_instances f
        WHERE f.person_id = p.id
      )
  `);

  log.info(
    { created, updated, noise, clusters: clusters.size },
    "clustering complete"
  );

  return { created, updated, noise };
}
