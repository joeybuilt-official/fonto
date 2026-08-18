// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";
import { cacheInvalidate } from "@/lib/cache/valkey";
import { nextSeq } from "@/lib/db/seq";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, id),
        inArray(schema.projects.workspaceId, workspaceIds),
        isNull(schema.projects.deletedAt)
      )
    )
    .limit(1);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const collections = await db
    .select()
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.projectId, id),
        inArray(schema.collections.workspaceId, workspaceIds),
        isNull(schema.collections.deletedAt)
      )
    )
    .orderBy(schema.collections.sortOrder, schema.collections.createdAt);

  return NextResponse.json({ project, collections });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  // Phase 3.1 — editor required to mutate a project. Look up the row first
  // so we can scope the gate to the right workspace. Soft-deleted projects
  // are not mutable.
  const [existing] = await db
    .select({ workspaceId: schema.projects.workspaceId })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, id),
        inArray(schema.projects.workspaceId, workspaceIds),
        isNull(schema.projects.deletedAt)
      )
    )
    .limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const parsed = await parseJson<{ name?: string; description?: string; color?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  // Delta-sync: bump seq so the edit surfaces on /sync/projects.
  const seq = await nextSeq(existing.workspaceId, "project");
  const updates: Record<string, unknown> = { updatedAt: new Date(), seq };
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.description !== undefined) updates.description = String(body.description);
  if (body.color !== undefined) updates.color = body.color;

  const [updated] = await db
    .update(schema.projects)
    .set(updates)
    .where(and(eq(schema.projects.id, id), inArray(schema.projects.workspaceId, workspaceIds)))
    .returning();
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  revalidateTag(`ws:${existing.workspaceId}:projects`, "max");
  return NextResponse.json({ project: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  // Phase 3.1 — editor required to delete a project. Already-deleted
  // projects 404 (idempotent soft-delete).
  const [existing] = await db
    .select({ workspaceId: schema.projects.workspaceId })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, id),
        inArray(schema.projects.workspaceId, workspaceIds),
        isNull(schema.projects.deletedAt)
      )
    )
    .limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  // Detach collections from project before soft-deleting it.
  await db
    .update(schema.collections)
    .set({ projectId: null })
    .where(and(eq(schema.collections.projectId, id), inArray(schema.collections.workspaceId, workspaceIds)));

  // Soft-delete (delta-sync): stamp deleted_at and bump seq so the row
  // surfaces as a `delete` tombstone on /sync/projects instead of vanishing.
  const seq = await nextSeq(existing.workspaceId, "project");
  const [deleted] = await db
    .update(schema.projects)
    .set({ deletedAt: new Date(), seq, updatedAt: new Date() })
    .where(and(eq(schema.projects.id, id), inArray(schema.projects.workspaceId, workspaceIds)))
    .returning({ id: schema.projects.id });
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Project deletion detaches its collections (projectId → null) above, so
  // both the projects and collections catalogues need to evict at the
  // Next-cache level and the Valkey layer (T2.2 — collections has a Valkey
  // overlay; projects does not yet, so the cacheInvalidate is a no-op
  // there until that route gets wired).
  revalidateTag(`ws:${existing.workspaceId}:projects`, "max");
  revalidateTag(`ws:${existing.workspaceId}:collections`, "max");
  void cacheInvalidate(`ws:${existing.workspaceId}:collections`);
  return NextResponse.json({ ok: true });
}
