// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. CHEAP counts for the review-queue nav badge +
// load-time nudge. Deliberately avoids the SSIM-heavy variant manifest: the
// badge headline is the exact, actionable date-review queue; variant candidate
// groups + unnamed clusters ride along as context (the true "variant needs
// review" count requires Stage-2 SSIM and is computed only when the screen
// opens). Owner-only; non-owners get 403 so the client can hide the link.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { DEFAULT_GATE_THRESHOLDS } from "@/lib/fusion/gate";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const HIGH = DEFAULT_GATE_THRESHOLDS.date.high;
  const LOW = DEFAULT_GATE_THRESHOLDS.date.low;
  const conf = schema.imageDateInference.confidence;
  const conflictCol = schema.imageDateInference.conflictFlag;

  const [dateRow] = await db
    .select({
      review: sql<number>`count(*) filter (where (${conflictCol} and ${conf} >= ${LOW}) or (not ${conflictCol} and ${conf} >= ${LOW} and ${conf} < ${HIGH}))::int`,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(
      and(
        eq(schema.assets.workspaceId, workspace.id),
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.imageDateInference.status, "inferred")
      )
    );

  const [variantRow] = await db
    .select({ candidates: sql<number>`count(*)::int` })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspace.id),
        eq(schema.variantGroups.status, "candidate")
      )
    );

  const [identityRow] = await db
    .select({ unnamed: sql<number>`count(*)::int` })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.workspaceId, workspace.id),
        isNull(schema.persons.name),
        eq(schema.persons.hidden, false),
        sql`${schema.persons.instanceCount} >= 2`
      )
    );

  const dateReview = dateRow?.review ?? 0;
  return NextResponse.json({
    ok: true,
    // Headline badge = the actionable date-decision queue.
    total: dateReview,
    dateReview,
    variantCandidates: variantRow?.candidates ?? 0,
    identityUnnamed: identityRow?.unnamed ?? 0,
  });
}
