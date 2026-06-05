// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Task 20 (Phase 3) — auto-stacking maintenance job.
//
// Walks every workspace, runs the (read-only) `suggestStacks` heuristics, and
// materialises each suggestion into a stack via `createStack`. This is the
// only place suggestions become real stacks without an explicit user accept,
// so it is deliberately conservative AND fully reversible:
//   - it only ever sets `assets.stack_id` (never hides/deletes a member);
//   - `suggestStacks` already excludes already-stacked assets, so re-runs are
//     idempotent — a second tick stacks only newly-eligible groups;
//   - oversized clusters are skipped (a sane-burst cap; a giant "cluster" is a
//     data artifact, not a real burst — see the sentinel guard in suggest.ts);
//   - a user can unstack at any time via DELETE /api/v1/stacks/:id.
//
// Conservatism lives in `suggestStacks` (windowed thresholds + the pre-1990
// sentinel guard); this job adds one extra belt — `STACK_AUTO_MAX_MEMBERS`.

import { db, schema } from "@/lib/db";
import { suggestStacks } from "./suggest";
import { createStack } from "./operations";

export interface AutoStackResult {
  workspacesScanned: number;
  suggestions: number;
  stacksCreated: number;
  assetsStacked: number;
  skippedOversized: number;
  skippedConflict: number;
}

/**
 * Upper bound on members an auto-created stack may have. A legitimate still
 * burst rarely exceeds a few dozen frames; anything larger is almost always a
 * shared-fallback-timestamp import artifact that slipped past the sentinel
 * guard. Such clusters are SKIPPED (not truncated) so we never half-collapse a
 * real group. Env-overridable for tuning. Default 30.
 */
function autoStackMaxMembers(): number {
  const raw = process.env.STACK_AUTO_MAX_MEMBERS;
  const n = raw ? Number(raw) : 30;
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 30;
}

export async function runAutoStack(): Promise<AutoStackResult> {
  const maxMembers = autoStackMaxMembers();
  const workspaces = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces);

  const result: AutoStackResult = {
    workspacesScanned: 0,
    suggestions: 0,
    stacksCreated: 0,
    assetsStacked: 0,
    skippedOversized: 0,
    skippedConflict: 0,
  };

  for (const ws of workspaces) {
    result.workspacesScanned++;
    const suggestions = await suggestStacks(ws.id);
    result.suggestions += suggestions.length;

    for (const s of suggestions) {
      if (s.assetIds.length > maxMembers) {
        result.skippedOversized++;
        continue;
      }
      const created = await createStack({
        workspaceId: ws.id,
        assetIds: s.assetIds,
        primaryAssetId: s.assetIds[0],
      });
      if (created.ok) {
        result.stacksCreated++;
        result.assetsStacked += created.assetIds.length;
      } else {
        // A concurrent accept (or a stale suggestion racing another tick) can
        // leave a member already-stacked or missing. Benign — the next tick
        // re-derives from the live table.
        result.skippedConflict++;
      }
    }
  }

  return result;
}
