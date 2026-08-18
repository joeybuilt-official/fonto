// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. Batch accept/reject for the review queue.
//
// Date lane (REVERSIBLE in effect — it only writes a date, never deletes):
//   - confirm:    status='confirmed' + assets.captured_at = mapEstimate. This is
//                 the ONLY path that writes captured_at; the worker never does.
//   - reject:     status='overridden' — operator keeps the stored date.
//   - quarantine: status='quarantined' — park it, no further re-fuse.
//
// Variant lane:
//   - commit: commitConsolidation(groupId) — REVERSIBLE trash (sets
//             consolidation_state='trashed' + a grace window; undo reverts).
//             requireAutoCommit stays true: only gate-cleared groups act. This
//             is operator-initiated (the button click is the gate), never auto.
//
// Each lane runs in its own transaction; partial failure of one item does not
// roll back the others' lane (we collect per-item results).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { commitConsolidation } from "@/lib/variants/consolidate";
import { logger } from "@/lib/logger";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

type DateAction = "confirm" | "reject" | "quarantine";
type VariantAction = "commit";

interface Body {
  date?: Array<{ assetId: string; action: DateAction }>;
  variant?: Array<{ groupId: string; action: VariantAction }>;
}

const DATE_STATUS: Record<DateAction, string> = {
  confirm: "confirmed",
  reject: "overridden",
  quarantine: "quarantined",
};

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 });

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = await parseJson<Body>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const log = logger.child({ component: "review.confirm", workspaceId: workspace.id });
  const dateResults: Array<{ assetId: string; action: DateAction; ok: boolean; reason?: string }> = [];
  const variantResults: Array<{ groupId: string; ok: boolean; trashed: number; reason?: string }> = [];

  // ── Date lane ──────────────────────────────────────────────────────────
  const dateItems = Array.isArray(body.date) ? body.date : [];
  for (const item of dateItems) {
    if (!item?.assetId || !(item.action in DATE_STATUS)) {
      dateResults.push({ assetId: item?.assetId ?? "", action: item?.action, ok: false, reason: "bad-input" });
      continue;
    }
    try {
      const ok = await db.transaction(async (tx) => {
        // Re-read the proposal INSIDE the tx, scoped to the owner's workspace,
        // and only if still un-actioned (guards a double-submit / concurrent
        // worker re-fuse). Returns the MAP estimate for the confirm write.
        const [row] = await tx
          .select({
            mapEstimate: schema.imageDateInference.mapEstimate,
            status: schema.imageDateInference.status,
            ws: schema.assets.workspaceId,
          })
          .from(schema.imageDateInference)
          .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
          .where(eq(schema.imageDateInference.assetId, item.assetId))
          .limit(1);
        if (!row || row.ws !== workspace.id) return "not-found";
        if (row.status !== "inferred") return "already-actioned";

        await tx
          .update(schema.imageDateInference)
          .set({ status: DATE_STATUS[item.action] })
          .where(eq(schema.imageDateInference.assetId, item.assetId));

        if (item.action === "confirm" && row.mapEstimate) {
          await tx
            .update(schema.assets)
            .set({ capturedAt: new Date(row.mapEstimate) })
            .where(
              and(
                eq(schema.assets.id, item.assetId),
                eq(schema.assets.workspaceId, workspace.id)
              )
            );
        }
        return "ok";
      });
      if (ok === "ok") dateResults.push({ assetId: item.assetId, action: item.action, ok: true });
      else dateResults.push({ assetId: item.assetId, action: item.action, ok: false, reason: ok });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), assetId: item.assetId }, "date confirm failed");
      dateResults.push({ assetId: item.assetId, action: item.action, ok: false, reason: "error" });
    }
  }

  // ── Variant lane ───────────────────────────────────────────────────────
  const variantItems = Array.isArray(body.variant) ? body.variant : [];
  for (const item of variantItems) {
    if (!item?.groupId || item.action !== "commit") {
      variantResults.push({ groupId: item?.groupId ?? "", ok: false, trashed: 0, reason: "bad-input" });
      continue;
    }
    try {
      // Ownership gate: the variant group MUST belong to the owner's workspace.
      // commitConsolidation acts purely by groupId and reversibly trashes every
      // member, so without this a caller could pass a groupId from another
      // workspace (cross-tenant data mutation). Return not-found so we don't
      // leak cross-workspace group existence.
      const [group] = await db
        .select({ workspaceId: schema.variantGroups.workspaceId })
        .from(schema.variantGroups)
        .where(eq(schema.variantGroups.id, item.groupId))
        .limit(1);
      if (!group || group.workspaceId !== workspace.id) {
        variantResults.push({ groupId: item.groupId, ok: false, trashed: 0, reason: "not-found" });
        continue;
      }
      const res = await commitConsolidation(item.groupId, { requireAutoCommit: true });
      variantResults.push({
        groupId: item.groupId,
        ok: !res.skipped,
        trashed: res.trashed,
        reason: res.skipped ? res.reason : undefined,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), groupId: item.groupId }, "variant commit failed");
      variantResults.push({ groupId: item.groupId, ok: false, trashed: 0, reason: "error" });
    }
  }

  log.info(
    {
      dateOk: dateResults.filter((r) => r.ok).length,
      dateFail: dateResults.filter((r) => !r.ok).length,
      variantOk: variantResults.filter((r) => r.ok).length,
      trashed: variantResults.reduce((a, r) => a + r.trashed, 0),
    },
    "review batch applied"
  );

  return NextResponse.json({ date: dateResults, variant: variantResults });
}
