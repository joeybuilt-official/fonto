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

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { gateDecision, DEFAULT_GATE_THRESHOLDS } from "@/lib/fusion/gate";
import { buildWorkspaceManifests } from "@/lib/variants/consolidate";

const DATE_LANE_LIMIT = 60;
const VARIANT_LANE_LIMIT = 30;
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

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const variantLimit = Math.max(
    1,
    Math.min(VARIANT_LANE_LIMIT, Number(searchParams.get("variantLimit")) || VARIANT_LANE_LIMIT)
  );

  // ── Date lane ──────────────────────────────────────────────────────────
  // Pull un-actioned proposals for this workspace's assets, then partition with
  // the same gate the worker used. Surface only the rows the gate sent to a
  // human (review band + any conflict); count the auto-commit band separately.
  const inferenceRows = await db
    .select({
      assetId: schema.imageDateInference.assetId,
      mapEstimate: schema.imageDateInference.mapEstimate,
      mapPrecision: schema.imageDateInference.mapPrecision,
      ciLow: schema.imageDateInference.ciLow,
      ciHigh: schema.imageDateInference.ciHigh,
      confidence: schema.imageDateInference.confidence,
      conflictFlag: schema.imageDateInference.conflictFlag,
      explanation: schema.imageDateInference.explanation,
      filename: schema.assets.filename,
      capturedAt: schema.assets.capturedAt,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(
      and(
        eq(schema.assets.workspaceId, workspace.id),
        eq(schema.imageDateInference.status, "inferred"),
        eq(schema.assets.lifecycleState, "active")
      )
    )
    .orderBy(desc(schema.imageDateInference.confidence))
    .limit(500);

  const dateReview: DateItem[] = [];
  let dateAutoCommit = 0;
  let dateLeave = 0;
  for (const r of inferenceRows) {
    const decision = gateDecision({
      score: r.confidence,
      action: "date",
      conflict: r.conflictFlag,
    });
    if (decision === "auto-commit") {
      dateAutoCommit++;
      continue;
    }
    if (decision === "leave") {
      dateLeave++;
      continue;
    }
    if (dateReview.length < DATE_LANE_LIMIT) {
      dateReview.push({
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
      });
    }
  }

  // ── Variant lane ───────────────────────────────────────────────────────
  const manifests = await buildWorkspaceManifests(workspace.id, variantLimit);
  const variantGroups = manifests
    .filter((m) => m.decision !== "leave" && m.trashCandidates.length > 0)
    .map((m) => ({
      groupId: m.groupId,
      canonicalAssetId: m.canonicalAssetId,
      canonicalScore: Number(m.canonicalMetrics.score.toFixed(3)),
      confidence: Number(m.confidence.toFixed(3)),
      decision: m.decision,
      trashCandidates: m.trashCandidates.map((c) => ({
        assetId: c.assetId,
        ssim: Number((c.ssimToCanonical ?? 0).toFixed(3)),
      })),
      keptDistinct: m.keptDistinct.map((c) => c.assetId),
    }));

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
      groups: variantGroups,
      limit: variantLimit,
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
