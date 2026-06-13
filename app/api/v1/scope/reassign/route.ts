// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 — reversible bulk scope reassignment.
//
//   POST /api/v1/scope/reassign
//     Body: {
//       to: 'PERSONAL' | 'SHOOT',          // target scope (required)
//       shootId?: string | null,           // file SHOOT assets into a shoot
//       // selector — at least one of:
//       assetIds?: string[],
//       directoryPath?: string,            // exact folder match
//       directoryPathPrefix?: string,      // recursive (folder + descendants)
//       source?: string,                   // ingestion source tag
//     }
//     Returns { batchId, reassigned, scanned }.
//
// Every asset whose scope (or shoot membership) actually changes gets a row in
// fonto.scope_reassignments under one batchId, so the batch is undoable via
// POST /api/v1/scope/reassign/undo. No rename/delete — only the scope/shoot_id
// columns move. seq is bumped so mobile clients re-sync the change.
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray, like, type SQL } from "drizzle-orm";
import { nextSeq } from "@/lib/db/seq";
import { isScope, type Scope } from "@/lib/scope";

interface Body {
  to?: unknown;
  shootId?: unknown;
  assetIds?: unknown;
  directoryPath?: unknown;
  directoryPathPrefix?: unknown;
  source?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!isScope(body?.to)) {
    return NextResponse.json({ error: "`to` must be 'PERSONAL' or 'SHOOT'" }, { status: 400 });
  }
  const to: Scope = body.to;
  const shootId = typeof body?.shootId === "string" ? body.shootId : null;

  // Build the selector. At least one selector dimension is required so we never
  // accidentally reassign an entire workspace on an empty body.
  const sel: SQL[] = [eq(schema.assets.workspaceId, workspaceId)];
  let hasSelector = false;
  if (Array.isArray(body?.assetIds) && body.assetIds.length > 0) {
    const ids = body.assetIds.filter((x): x is string => typeof x === "string");
    if (ids.length > 0) {
      sel.push(inArray(schema.assets.id, ids));
      hasSelector = true;
    }
  }
  if (typeof body?.directoryPath === "string" && body.directoryPath.trim() !== "") {
    sel.push(eq(schema.assets.directoryPath, body.directoryPath.trim()));
    hasSelector = true;
  } else if (
    typeof body?.directoryPathPrefix === "string" &&
    body.directoryPathPrefix.trim() !== ""
  ) {
    const norm = body.directoryPathPrefix.trim().replace(/\/+$/, "");
    sel.push(like(schema.assets.directoryPath, `${norm}/%`));
    hasSelector = true;
  }
  if (typeof body?.source === "string" && body.source.trim() !== "") {
    sel.push(eq(schema.assets.source, body.source.trim()));
    hasSelector = true;
  }
  if (!hasSelector) {
    return NextResponse.json(
      { error: "A selector is required (assetIds, directoryPath, directoryPathPrefix, or source)" },
      { status: 400 }
    );
  }

  const rows = await db
    .select({
      id: schema.assets.id,
      scope: schema.assets.scope,
      shootId: schema.assets.shootId,
    })
    .from(schema.assets)
    .where(and(...sel));

  const targetShootId = to === "SHOOT" ? shootId : null;
  const batchId = randomUUID();
  let reassigned = 0;

  for (const a of rows) {
    const scopeChanged = a.scope !== to;
    const shootChanged = (a.shootId ?? null) !== targetShootId;
    if (!scopeChanged && !shootChanged) continue; // no-op — don't log

    const seq = await nextSeq(workspaceId, "asset");
    await db
      .update(schema.assets)
      .set({ scope: to, shootId: targetShootId, seq, updatedAt: new Date() })
      .where(eq(schema.assets.id, a.id));

    await db
      .insert(schema.scopeReassignments)
      .values({
        workspaceId,
        assetId: a.id,
        batchId,
        fromScope: a.scope,
        toScope: to,
        fromShootId: a.shootId ?? null,
        toShootId: targetShootId,
        actor: user.id,
      })
      .onConflictDoNothing();
    reassigned += 1;
  }

  return NextResponse.json({ batchId, reassigned, scanned: rows.length });
}
