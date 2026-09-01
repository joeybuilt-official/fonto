// SPDX-License-Identifier: MIT
//
// T1.3 (docs/claude/platform/completed/perf-audit/perf-audit-plan.md) — class-B workspace-scoped catalogue.
// See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

const loadCorrespondents = (workspaceIds: string[]) => {
  const key = [...workspaceIds].sort().join(",");
  return unstable_cache(
    async () =>
      db
        .select()
        .from(schema.correspondents)
        .where(inArray(schema.correspondents.workspaceId, workspaceIds))
        .orderBy(schema.correspondents.name),
    ["correspondents-list", key],
    {
      tags: workspaceIds.map((id) => `ws:${id}:correspondents`),
      revalidate: 300,
    }
  )();
};

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ correspondents: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const correspondents = await loadCorrespondents(workspaceIds);

  return NextResponse.json({ correspondents });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Phase 3.1 — editor required to create correspondents.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaces[0].id, "editor");
  if (!gate.ok) return gate.response;

  const parsed = await parseJson<{ name?: string; matchPattern?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [correspondent] = await db
    .insert(schema.correspondents)
    .values({
      workspaceId: workspaces[0].id,
      name,
      matchPattern: body.matchPattern ?? null,
    })
    .returning();

  revalidateTag(`ws:${workspaces[0].id}:correspondents`, "max");
  return NextResponse.json({ correspondent }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const workspaceIds = workspaces.map((w) => w.id);

  const parsed = await parseJson<{ id?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Phase 3.1 — editor required to delete a correspondent. Resolve its
  // workspace first so the gate runs against the right id.
  const [existing] = await db
    .select({ workspaceId: schema.correspondents.workspaceId })
    .from(schema.correspondents)
    .where(and(eq(schema.correspondents.id, body.id), inArray(schema.correspondents.workspaceId, workspaceIds)))
    .limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db
    .delete(schema.correspondents)
    .where(and(eq(schema.correspondents.id, body.id), inArray(schema.correspondents.workspaceId, workspaceIds)));

  revalidateTag(`ws:${existing.workspaceId}:correspondents`, "max");
  return NextResponse.json({ ok: true });
}
