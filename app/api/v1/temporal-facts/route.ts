// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 2 (ADR-0002): GET/POST /api/v1/temporal-facts.
//   GET  — list the caller workspace's facts (newest first; ?type= filter).
//   POST — author a new fact. origin is always 'human' from this endpoint
//          (machine-proposed facts are written by the engine, not the UI).
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { validateFactInput, FACT_TYPES, type FactType } from "@/lib/temporal/factInput";
import { db, schema } from "@/lib/db";

function serialize(f: typeof schema.temporalFacts.$inferSelect) {
  return {
    ...f,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ facts: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const typeFilter = request.nextUrl.searchParams.get("type");
  const where =
    typeFilter && FACT_TYPES.includes(typeFilter as FactType)
      ? and(
          inArray(schema.temporalFacts.workspaceId, workspaceIds),
          eq(schema.temporalFacts.type, typeFilter)
        )
      : inArray(schema.temporalFacts.workspaceId, workspaceIds);

  const rows = await db
    .select()
    .from(schema.temporalFacts)
    .where(where)
    .orderBy(desc(schema.temporalFacts.createdAt));

  return NextResponse.json({ facts: rows.map(serialize) });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length)
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const workspaceId =
    typeof body.workspaceId === "string" && workspaces.some((w) => w.id === body.workspaceId)
      ? (body.workspaceId as string)
      : workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const result = validateFactInput(body, "create");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const v = result.value;

  const [fact] = await db
    .insert(schema.temporalFacts)
    .values({
      workspaceId,
      type: v.type!,
      label: v.label!,
      dateStart: v.dateStart ?? null,
      dateStartPrecision: v.dateStartPrecision ?? null,
      dateEnd: v.dateEnd ?? null,
      dateEndPrecision: v.dateEndPrecision ?? null,
      recurrence: v.recurrence ?? null,
      locationLabel: v.locationLabel ?? null,
      personIds: v.personIds ?? [],
      confidence: v.confidence ?? 1,
      origin: "human",
    })
    .returning();

  return NextResponse.json({ fact: serialize(fact) }, { status: 201 });
}
