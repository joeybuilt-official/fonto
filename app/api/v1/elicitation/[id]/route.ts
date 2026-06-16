// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5.5: POST /api/v1/elicitation/:id — record an answer.
//
//   confirm_date  { confirm:true, date? } → image_date_inference.status='confirmed'
//                 + assets.captured_at = (date | proposed). { confirm:false } →
//                 status='overridden'. (Same effect as the review-queue confirm.)
//   birth_year    { year:number } → persons.birth_date = <year>-01-01 (year
//                 precision) → Phase-7 re-audit of every photo that person is in.
//
// Either way the question flips to answered. DELETE dismisses a question.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { invalidateByDependency } from "@/lib/reaudit/invalidate";

async function loadQuestion(id: string, workspaceIds: string[]) {
  const [row] = await db
    .select()
    .from(schema.elicitationQuestions)
    .where(
      and(
        eq(schema.elicitationQuestions.id, id),
        inArray(schema.elicitationQuestions.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const q = await loadQuestion(id, workspaceIds);
  if (!q) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, q.workspaceId, "editor");
  if (!gate.ok) return gate.response;
  if (q.status !== "open") return NextResponse.json({ error: "Already answered" }, { status: 409 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (q.kind === "confirm_date" && q.targetId) {
    const confirm = body.confirm !== false;
    const payload = (q.payload ?? {}) as { proposedDate?: string };
    const date = typeof body.date === "string" ? body.date : payload.proposedDate;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.imageDateInference)
        .set({ status: confirm ? "confirmed" : "overridden" })
        .where(
          and(
            eq(schema.imageDateInference.assetId, q.targetId as string),
            eq(schema.imageDateInference.status, "inferred")
          )
        );
      if (confirm && date) {
        await tx
          .update(schema.assets)
          .set({ capturedAt: new Date(date) })
          .where(and(eq(schema.assets.id, q.targetId as string), eq(schema.assets.workspaceId, q.workspaceId)));
      }
      await tx
        .update(schema.elicitationQuestions)
        .set({ status: "answered", answer: { confirm, date }, answeredAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.elicitationQuestions.id, q.id));
    });
    return NextResponse.json({ ok: true });
  }

  if (q.kind === "birth_year" && q.targetId) {
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) {
      return NextResponse.json({ error: "year must be an integer (1900..now)" }, { status: 400 });
    }
    await db.transaction(async (tx) => {
      await tx
        .update(schema.persons)
        .set({ birthDate: `${year}-01-01`, birthPrecision: "year", updatedAt: new Date() })
        .where(and(eq(schema.persons.id, q.targetId as string), eq(schema.persons.workspaceId, q.workspaceId)));
      await tx
        .update(schema.elicitationQuestions)
        .set({ status: "answered", answer: { year }, answeredAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.elicitationQuestions.id, q.id));
    });
    // Phase 7 — a new birth anchor re-audits every photo this person is in.
    void invalidateByDependency({ workspaceId: q.workspaceId, personIds: [q.targetId] });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `Unsupported question kind: ${q.kind}` }, { status: 400 });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const q = await loadQuestion(id, workspaceIds);
  if (!q) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, q.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  await db
    .update(schema.elicitationQuestions)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(eq(schema.elicitationQuestions.id, q.id));
  return NextResponse.json({ ok: true });
}
