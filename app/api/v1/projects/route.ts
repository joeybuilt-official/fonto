// SPDX-License-Identifier: MIT
//
// T1.3 (fonto-perf-audit.md) — class-B workspace-scoped catalogue.
// See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";
import { nextSeq } from "@/lib/db/seq";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

const loadProjects = (workspaceIds: string[]) => {
  const key = [...workspaceIds].sort().join(",");
  return unstable_cache(
    async () =>
      db
        .select()
        .from(schema.projects)
        // Hide soft-deleted projects from the catalogue; the /sync feed
        // still surfaces them as tombstones.
        .where(and(inArray(schema.projects.workspaceId, workspaceIds), isNull(schema.projects.deletedAt)))
        .orderBy(desc(schema.projects.updatedAt)),
    ["projects-list", key],
    {
      tags: workspaceIds.map((id) => `ws:${id}:projects`),
      revalidate: 300,
    }
  )();
};

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ projects: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const projects = await loadProjects(workspaceIds);

  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Phase 3.1 — editor required to create projects.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaces[0].id, "editor");
  if (!gate.ok) return gate.response;

  const parsed = await parseJson<{ name?: string; description?: string; color?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  // Delta-sync: allocate a seq for this new project.
  const seq = await nextSeq(workspaces[0].id, "project");
  const [project] = await db
    .insert(schema.projects)
    .values({
      workspaceId: workspaces[0].id,
      userId: user.id,
      name,
      description: String(body.description ?? ""),
      color: body.color ?? "#6366f1",
      seq,
    })
    .returning();

  revalidateTag(`ws:${workspaces[0].id}:projects`, "max");
  return NextResponse.json({ project }, { status: 201 });
}
