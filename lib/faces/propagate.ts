// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// After a person is named, find face_instances visually similar to that
// person's faces that haven't yet been assigned to any NAMED person.
//
// Phase 1 (faces/UX), D2 HYBRID:
//   - distance <= EPS_AUTO (tight, default 0.26)  → silent auto-assign.
//   - EPS_AUTO < distance <= EPS_SUGGEST (0.32)    → counted as a SUGGESTION
//     only; NOT auto-assigned. Callers surface "review N" and the per-face
//     suggestions endpoint serves the borderline band for confirm-then-add.
// Silently sweeping the borderline band in was painful to undo (ADR 0001,
// pre-mortem #2), so we keep auto-assign tight + leave the rest to confirm.

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { recomputeCoverFacesForWorkspace } from "@/lib/faces/cluster";

// Tight auto-assign threshold — env-tunable. Anything at/under this is
// confidently the same person and gets assigned without asking.
const EPS_AUTO = (() => {
  const raw = Number(process.env.FACE_MATCH_EPS_AUTO);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.26;
})();
// Borderline ceiling — the (EPS_AUTO, EPS_SUGGEST] band is offered for review,
// not auto-assigned. Matches the historical DBSCAN/propagate default.
const EPS_SUGGEST = 0.32;

export interface PropagateResult {
  /** Faces auto-assigned to the person (distance <= EPS_AUTO). */
  assigned: number;
  /** Borderline candidates in (EPS_AUTO, EPS_SUGGEST] — surfaced for review. */
  suggested: number;
}

export async function propagateNamedPerson(
  personId: string,
  workspaceId: string
): Promise<PropagateResult> {
  // 1. Get all embeddings for this named person.
  const anchors = await db
    .select({ embedding: schema.faceInstances.embedding })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.personId, personId),
        eq(schema.faceInstances.workspaceId, workspaceId)
      )
    );
  if (anchors.length === 0) return { assigned: 0, suggested: 0 };

  // 2. Find IDs of all other NAMED persons in this workspace (to protect their faces).
  const namedPersons = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.workspaceId, workspaceId),
        ne(schema.persons.id, personId),
        sql`${schema.persons.name} IS NOT NULL`
      )
    );
  const protectedPersonIds = namedPersons.map((p) => p.id);
  void protectedPersonIds; // used indirectly via SQL filter below

  // 3. For each anchor embedding, find unprotected faces within EPS_SUGGEST
  //    distance using pgvector cosine distance (<=>). We split each candidate
  //    into the auto band (<= EPS_AUTO) and the suggest band by its MINIMUM
  //    distance across anchors — a face that is tight to ANY anchor is auto.
  const minDistByFace = new Map<string, number>();

  for (const { embedding } of anchors) {
    if (!Array.isArray(embedding) || embedding.length === 0) continue;
    const vecLiteral = `[${embedding.join(",")}]`;

    // Find faces within EPS_SUGGEST cosine distance that are:
    //   - not already this person
    //   - not belonging to any other named person
    const candidates = (await db.execute(sql`
      SELECT fi.id, (fi.embedding::vector <=> ${vecLiteral}::vector) AS dist
      FROM fonto.face_instances fi
      LEFT JOIN fonto.persons p ON p.id = fi.person_id
      WHERE fi.workspace_id = ${workspaceId}
        AND fi.person_id IS DISTINCT FROM ${personId}
        AND (p.name IS NULL OR fi.person_id IS NULL)
        AND fi.embedding IS NOT NULL
        AND (fi.embedding::vector <=> ${vecLiteral}::vector) <= ${EPS_SUGGEST}
    `)) as unknown as { id: string; dist: number }[];

    for (const row of candidates) {
      const d = typeof row.dist === "number" ? row.dist : Number(row.dist);
      if (!Number.isFinite(d)) continue;
      const prev = minDistByFace.get(row.id);
      if (prev === undefined || d < prev) minDistByFace.set(row.id, d);
    }
  }

  if (minDistByFace.size === 0) return { assigned: 0, suggested: 0 };

  // 4. Partition into auto-assign vs suggest by min distance.
  const toAssign: string[] = [];
  let suggested = 0;
  for (const [faceId, dist] of minDistByFace) {
    if (dist <= EPS_AUTO) toAssign.push(faceId);
    else suggested++; // (EPS_AUTO, EPS_SUGGEST] — review band, not assigned.
  }

  if (toAssign.length === 0) {
    return { assigned: 0, suggested };
  }

  // 5. Bulk assign only the tight matches.
  await db
    .update(schema.faceInstances)
    .set({ personId })
    .where(inArray(schema.faceInstances.id, toAssign));

  // 6. Recompute instance_count for affected persons.
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

  // The newly-attached faces may include a higher-quality candidate than
  // whatever was used as the cover before — re-rank so the user sees the
  // best face for the freshly-named person.
  await recomputeCoverFacesForWorkspace(workspaceId);

  return { assigned: toAssign.length, suggested };
}
