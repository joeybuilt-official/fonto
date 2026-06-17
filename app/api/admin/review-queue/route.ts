// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. Read-only feed for the reconciliation review
// queue. Three lanes, each surfacing already-computed proposals that the gate
// routed to a human:
//
//   - date:     image_date_inference rows the date-gate sent to `review`
//               (mid-confidence) or that carry a conflict with the stored
//               captured_at. The auto-commit (high-confidence) count is also
//               returned so the operator can batch-confirm them.
//   - variant:  Phase-5 dry-run manifests routed to `auto-commit`/`review`
//               (canonical pick + SSIM-verified trash candidates).
//   - identity: unnamed face clusters (persons with name IS NULL) — the merge/
//               name action lives in the People surface (Phase 5.5 elicitation
//               wires the in-queue action); here it is an informational lane.
//
// Authz: workspace owner only, mirroring app/admin/jobs.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { DEFAULT_GATE_THRESHOLDS } from "@/lib/fusion/gate";

const DATE_LANE_LIMIT = 60;
const IDENTITY_LANE_LIMIT = 40;

interface DateItem {
  assetId: string;
  filename: string;
  capturedAt: string | null;
  mapEstimate: string | null;
  mapPrecision: string | null;
  ciLow: string | null;
  ciHigh: string | null;
  confidence: number;
  conflict: boolean;
  reasons: string[];
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // ── Date lane ──────────────────────────────────────────────────────────
  // The gate (lib/fusion/gate) routes a date to: auto-commit (conf >= HIGH, no
  // conflict) · review (conflict with conf >= LOW, or LOW <= conf < HIGH) ·
  // leave (the rest). We push the review predicate straight into SQL — a naive
  // "fetch top-N by confidence then partition" starves the review band, since
  // thousands of auto-commit rows outrank it.
  const HIGH = DEFAULT_GATE_THRESHOLDS.date.high;
  const LOW = DEFAULT_GATE_THRESHOLDS.date.low;
  const conf = schema.imageDateInference.confidence;
  const conflictCol = schema.imageDateInference.conflictFlag;
  const baseDateWhere = and(
    eq(schema.assets.workspaceId, workspace.id),
    eq(schema.assets.lifecycleState, "active"),
    eq(schema.imageDateInference.status, "inferred")
  );
  const reviewBand = sql`((${conflictCol} and ${conf} >= ${LOW}) or (not ${conflictCol} and ${conf} >= ${LOW} and ${conf} < ${HIGH}))`;

  const [dateCounts] = await db
    .select({
      autoCommit: sql<number>`count(*) filter (where not ${conflictCol} and ${conf} >= ${HIGH})::int`,
      review: sql<number>`count(*) filter (where ${reviewBand})::int`,
      leave: sql<number>`count(*) filter (where not ${conflictCol} and ${conf} < ${LOW})::int`,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(baseDateWhere);

  const reviewRows = await db
    .select({
      assetId: schema.imageDateInference.assetId,
      mapEstimate: schema.imageDateInference.mapEstimate,
      mapPrecision: schema.imageDateInference.mapPrecision,
      ciLow: schema.imageDateInference.ciLow,
      ciHigh: schema.imageDateInference.ciHigh,
      confidence: conf,
      conflictFlag: conflictCol,
      explanation: schema.imageDateInference.explanation,
      filename: schema.assets.filename,
      capturedAt: schema.assets.capturedAt,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(and(baseDateWhere, reviewBand))
    // Conflicts first (most actionable), then most-uncertain.
    .orderBy(desc(conflictCol), asc(conf))
    .limit(DATE_LANE_LIMIT);

  const dateReview: DateItem[] = reviewRows.map((r) => ({
    assetId: r.assetId,
    filename: r.filename,
    capturedAt: r.capturedAt ? new Date(r.capturedAt).toISOString() : null,
    mapEstimate: r.mapEstimate ? String(r.mapEstimate) : null,
    mapPrecision: r.mapPrecision,
    ciLow: r.ciLow ? String(r.ciLow) : null,
    ciHigh: r.ciHigh ? String(r.ciHigh) : null,
    confidence: Number(r.confidence.toFixed(3)),
    conflict: r.conflictFlag,
    reasons: topReasons(r.explanation),
  }));
  const dateAutoCommit = dateCounts?.autoCommit ?? 0;
  const dateLeave = dateCounts?.leave ?? 0;

  // ── Variant lane (cheap COUNT only) ─────────────────────────────────────
  // The SSIM-heavy manifests are built lazily + paged by the dedicated
  // /api/admin/review-queue/variants endpoint when the operator opens the
  // "Tidy up look-alikes" chip. Here we just surface the candidate count.
  const [variantRow] = await db
    .select({ candidates: sql<number>`count(*)::int` })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspace.id),
        eq(schema.variantGroups.status, "candidate")
      )
    );

  // ── Identity lane (informational) ──────────────────────────────────────
  const unnamed = await db
    .select({
      id: schema.persons.id,
      instanceCount: schema.persons.instanceCount,
      coverFaceId: schema.persons.coverFaceId,
    })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.workspaceId, workspace.id),
        isNull(schema.persons.name),
        eq(schema.persons.hidden, false),
        sql`${schema.persons.instanceCount} >= 2`
      )
    )
    .orderBy(desc(schema.persons.instanceCount))
    .limit(IDENTITY_LANE_LIMIT);

  return NextResponse.json({
    workspaceId: workspace.id,
    thresholds: DEFAULT_GATE_THRESHOLDS,
    date: {
      review: dateReview,
      counts: { review: dateReview.length, autoCommit: dateAutoCommit, leave: dateLeave },
    },
    variant: {
      count: variantRow?.candidates ?? 0,
      groups: [],
    },
    identity: {
      clusters: unnamed.map((p) => ({
        personId: p.id,
        instanceCount: p.instanceCount,
        coverFaceId: p.coverFaceId,
      })),
    },
  });
}

/** Pull a few human-readable lines out of the ranked-explanation jsonb. */
function topReasons(explanation: unknown): string[] {
  if (!Array.isArray(explanation)) return [];
  return explanation
    .slice(0, 3)
    .map((e) => {
      if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        const label = typeof o.evidenceType === "string" ? o.evidenceType : typeof o.type === "string" ? o.type : null;
        const detail = typeof o.detail === "string" ? o.detail : typeof o.summary === "string" ? o.summary : null;
        if (label && detail) return `${label}: ${detail}`;
        if (label) return label;
        if (detail) return detail;
      }
      if (typeof e === "string") return e;
      return null;
    })
    .filter((x): x is string => !!x);
}
