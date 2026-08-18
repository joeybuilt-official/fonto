// SPDX-License-Identifier: MIT
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
import { revalidateTag } from "next/cache";
import { randomUUID } from "crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { pgArray } from "@/lib/db/sql-helpers";
import { isScope, type Scope } from "@/lib/scope";
import { cacheInvalidate } from "@/lib/cache/valkey";

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

  // Only rows whose scope or shoot membership actually changes are rewritten
  // (and logged). Filtering up front keeps no-ops out of the batch.
  const changed = rows.filter(
    (a) => a.scope !== to || (a.shootId ?? null) !== targetShootId,
  );

  if (changed.length > 0) {
    // Batch the writes instead of one nextSeq + UPDATE + INSERT round-trip per
    // row — a directoryPathPrefix/source selector can match thousands of
    // assets, and the old per-row loop turned one request into thousands of
    // serial DB round-trips (risking gateway timeouts). Each reassigned asset
    // still needs a DISTINCT seq: the delta-sync feed (/sync/assets) pages by
    // `seq > cursor`, so rows sharing a seq value would be dropped mid-page.
    // We block-allocate N contiguous seqs in one atomic statement, then chunk
    // the UPDATE (per-row seq via unnest) and the reassignment-log INSERT, all
    // inside one transaction.
    const N = changed.length;
    await db.transaction(async (tx) => {
      // Block-allocate N per-workspace asset seqs (mirrors lib/db/seq.ts
      // nextSeq, incrementing by N in a single atomic upsert). The allocated
      // block is [firstSeq .. maxSeq].
      const seqRows = (await tx.execute(sql`
        INSERT INTO fonto.workspace_seq (workspace_id, asset_seq)
        VALUES (${workspaceId}, ${N})
        ON CONFLICT (workspace_id) DO UPDATE
          SET asset_seq = fonto.workspace_seq.asset_seq + ${N}
        RETURNING asset_seq AS seq
      `)) as unknown as Array<{ seq: string | number | bigint }>;
      const maxSeqRaw = seqRows[0]?.seq;
      if (maxSeqRaw == null) {
        throw new Error(
          `scope/reassign: seq allocation returned no row for workspace=${workspaceId}`,
        );
      }
      const maxSeq = typeof maxSeqRaw === "bigint" ? maxSeqRaw : BigInt(maxSeqRaw);
      const firstSeq = maxSeq - BigInt(N) + 1n;

      const CHUNK = 1000;
      for (let i = 0; i < changed.length; i += CHUNK) {
        const slice = changed.slice(i, i + CHUNK);
        const ids = slice.map((a) => a.id);
        const seqs = slice.map((_, j) => (firstSeq + BigInt(i + j)).toString());

        // One UPDATE per chunk: scope/shoot are constant across the batch;
        // the distinct per-row seq is joined in via unnest(ids, seqs).
        await tx.execute(sql`
          UPDATE fonto.assets AS a
          SET scope = ${to},
              shoot_id = ${targetShootId}::uuid,
              updated_at = now(),
              seq = v.seq
          FROM unnest(${pgArray(ids)}::uuid[], ${pgArray(seqs)}::bigint[]) AS v(id, seq)
          WHERE a.id = v.id AND a.workspace_id = ${workspaceId}
        `);

        // One multi-row INSERT per chunk for the reversible reassignment log.
        await tx
          .insert(schema.scopeReassignments)
          .values(
            slice.map((a) => ({
              workspaceId,
              assetId: a.id,
              batchId,
              fromScope: a.scope,
              toScope: to,
              fromShootId: a.shootId ?? null,
              toShootId: targetShootId,
              actor: user.id,
            })),
          )
          .onConflictDoNothing();
      }
    });

    // T1.3' — evict every aggregate cache that embeds asset rows/counts.
    revalidateTag(`ws:${workspaceId}:assets`, "max");
    void cacheInvalidate(`ws:${workspaceId}:assets`);
  }

  return NextResponse.json({ batchId, reassigned: changed.length, scanned: rows.length });
}
