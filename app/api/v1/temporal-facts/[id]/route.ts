// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 2 (ADR-0002): /api/v1/temporal-facts/:id
//   PATCH  — edit any subset of a fact's fields (validated, partial-date aware).
//   DELETE — remove a fact.
// A fact edit is a dependency change that the re-audit layer (Phase 7) will key
// invalidation on — for now the write is plain; the invalidation hook lands
// with Phase 7.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { validateFactInput } from "@/lib/temporal/factInput";
import { db, schema } from "@/lib/db";

async function loadFactInWorkspaces(id: string, workspaceIds: string[]) {
  const [row] = await db
    .select()
    .from(schema.temporalFacts)
    .where(
      and(
        eq(schema.temporalFacts.id, id),
        inArray(schema.temporalFacts.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  return row ?? null;
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

  const fact = await loadFactInWorkspaces(id, workspaceIds);
  if (!fact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, fact.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = validateFactInput(body, "patch");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const [updated] = await db
    .update(schema.temporalFacts)
    .set({ ...result.value, updatedAt: new Date() })
    .where(eq(schema.temporalFacts.id, fact.id))
    .returning();

  return NextResponse.json({
    fact: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const fact = await loadFactInWorkspaces(id, workspaceIds);
  if (!fact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, fact.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db.delete(schema.temporalFacts).where(eq(schema.temporalFacts.id, fact.id));
  return NextResponse.json({ ok: true as const });
}
