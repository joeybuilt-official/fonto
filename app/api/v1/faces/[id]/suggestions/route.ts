// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/faces/:id/suggestions
// Returns named persons ranked by visual similarity to this face.
// Used by the mobile tagging sheet to surface smart name suggestions.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ suggestions: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  // Load the target face.
  const [face] = await db
    .select({ embedding: schema.faceInstances.embedding, workspaceId: schema.faceInstances.workspaceId })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.id, id),
        inArray(schema.faceInstances.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!face || !face.embedding || !Array.isArray(face.embedding) || face.embedding.length === 0) {
    return NextResponse.json({ suggestions: [] });
  }

  const vecLiteral = `[${face.embedding.join(",")}]`;

  // Find the top 5 named persons by minimum cosine distance of any of their
  // faces to this face's embedding.
  const rows = (await db.execute(sql`
    SELECT p.id, p.name, p.instance_count,
           MIN(fi.embedding::vector <=> ${vecLiteral}::vector) AS min_dist
    FROM fonto.persons p
    JOIN fonto.face_instances fi ON fi.person_id = p.id
    WHERE p.workspace_id = ${face.workspaceId}
      AND p.name IS NOT NULL
      AND fi.embedding IS NOT NULL
    GROUP BY p.id
    ORDER BY min_dist ASC
    LIMIT 5
  `)) as unknown as { id: string; name: string; instance_count: number; min_dist: number }[];

  const suggestions = rows.map((row) => ({
    id: row.id,
    name: row.name,
    instanceCount: row.instance_count,
    distance: row.min_dist,
  }));

  return NextResponse.json({ suggestions });
}
