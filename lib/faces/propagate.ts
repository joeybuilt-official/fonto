// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// After a person is named, find all face_instances that are visually similar
// to that person's faces and haven't yet been assigned to any NAMED person.
// Assigns them to this person so tagging one photo names the whole archive.

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

const EPS = 0.32; // cosine-distance threshold — same as DBSCAN default

export async function propagateNamedPerson(
  personId: string,
  workspaceId: string
): Promise<number> {
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
  if (anchors.length === 0) return 0;

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

  // 3. For each anchor embedding, find unprotected faces within EPS distance
  //    using pgvector cosine distance operator (<=>).
  //    We collect all candidate face IDs across anchors then batch-assign.
  const toAssign = new Set<string>();

  for (const { embedding } of anchors) {
    if (!Array.isArray(embedding) || embedding.length === 0) continue;
    const vecLiteral = `[${embedding.join(",")}]`;

    // Find faces within EPS cosine distance that are:
    //   - not already this person
    //   - not belonging to any other named person
    const candidates = (await db.execute(sql`
      SELECT fi.id
      FROM fonto.face_instances fi
      LEFT JOIN fonto.persons p ON p.id = fi.person_id
      WHERE fi.workspace_id = ${workspaceId}
        AND fi.person_id IS DISTINCT FROM ${personId}
        AND (p.name IS NULL OR fi.person_id IS NULL)
        AND fi.embedding IS NOT NULL
        AND (fi.embedding::vector <=> ${vecLiteral}::vector) <= ${EPS}
    `)) as unknown as { id: string }[];

    for (const row of candidates) {
      toAssign.add(row.id);
    }
  }

  if (toAssign.size === 0) return 0;

  // 4. Bulk assign.
  const ids = Array.from(toAssign);
  await db
    .update(schema.faceInstances)
    .set({ personId })
    .where(inArray(schema.faceInstances.id, ids));

  // 5. Recompute instance_count for affected persons.
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

  return toAssign.size;
}
