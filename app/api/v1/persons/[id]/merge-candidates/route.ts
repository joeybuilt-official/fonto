// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/persons/:id/merge-candidates
// Returns named persons ranked by visual similarity to this source person's
// faces — the "Merge into" picker uses this to surface likely-duplicate
// people at the top of the list, mirroring the face-suggestion behaviour
// (`/api/v1/faces/:id/suggestions`).
//
// Scoring: for each face of the source person, take the minimum cosine
// distance to each candidate person's faces. The candidate's score is the
// minimum across all source faces (the closest face-pair wins). A sampled
// subset of source faces caps the cost on huge persons; we order by random()
// so the sample is representative rather than biased to the first inserts.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

// Per-merge sample cap on source faces. Above this we'd cross-join
// thousands of vectors with the workspace; 25 is plenty to identify the
// nearest neighbour cluster without breaking the query planner.
const SOURCE_SAMPLE = 25;
// Tightest distance band we'll surface as a likely match. Beyond ~0.55
// the embedding similarity is noise; no point listing rank-50 candidates.
const MAX_CANDIDATE_DISTANCE = 0.55;
const LIMIT = 20;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ candidates: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  // Confirm the source person belongs to one of the caller's workspaces.
  const [src] = await db
    .select({ id: schema.persons.id, workspaceId: schema.persons.workspaceId })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.id, id),
        inArray(schema.persons.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!src) return NextResponse.json({ candidates: [] });

  // For each candidate named person, take the minimum cosine distance from
  // ANY of their faces to ANY sampled source face. Drop persons further than
  // MAX_CANDIDATE_DISTANCE — at that point the embedding similarity is noise
  // and the user would be better served by alphabetical browsing.
  const rows = (await db.execute(sql`
    WITH src_sample AS (
      SELECT embedding
      FROM fonto.face_instances
      WHERE person_id = ${src.id}
        AND embedding IS NOT NULL
      ORDER BY random()
      LIMIT ${SOURCE_SAMPLE}
    )
    SELECT p.id, p.name, p.instance_count,
           MIN(tgt.embedding::vector <=> src.embedding::vector) AS min_dist
    FROM fonto.persons p
    JOIN fonto.face_instances tgt
      ON tgt.person_id = p.id AND tgt.embedding IS NOT NULL
    CROSS JOIN src_sample src
    WHERE p.workspace_id = ${src.workspaceId}
      AND p.id <> ${src.id}
      AND p.name IS NOT NULL
    GROUP BY p.id, p.name, p.instance_count
    HAVING MIN(tgt.embedding::vector <=> src.embedding::vector) < ${MAX_CANDIDATE_DISTANCE}
    ORDER BY min_dist ASC
    LIMIT ${LIMIT}
  `)) as unknown as {
    id: string;
    name: string;
    instance_count: number;
    min_dist: number;
  }[];

  const candidates = rows.map((row) => ({
    id: row.id,
    name: row.name,
    instanceCount: row.instance_count,
    distance: row.min_dist,
  }));

  return NextResponse.json({ candidates });
}
