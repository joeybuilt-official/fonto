// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5.5: /api/v1/elicitation
//   GET  — top open questions for the caller's workspace, ranked by info value.
//   POST — regenerate the open question set (confirm_date + birth_year).
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { generateElicitationQuestions } from "@/lib/elicitation/generate";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ questions: [] });
  const workspaceId = workspaces[0].id;

  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT);

  const rows = await db
    .select()
    .from(schema.elicitationQuestions)
    .where(
      and(
        eq(schema.elicitationQuestions.workspaceId, workspaceId),
        eq(schema.elicitationQuestions.status, "open")
      )
    )
    .orderBy(desc(schema.elicitationQuestions.infoValue))
    .limit(limit);

  return NextResponse.json({
    questions: rows.map((q) => ({
      id: q.id,
      kind: q.kind,
      targetType: q.targetType,
      targetId: q.targetId,
      prompt: q.prompt,
      payload: q.payload,
      infoValue: q.infoValue,
    })),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown };
  const workspaceId =
    typeof body.workspaceId === "string" && workspaces.some((w) => w.id === body.workspaceId)
      ? body.workspaceId
      : workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const result = await generateElicitationQuestions(workspaceId);
  return NextResponse.json(result);
}
