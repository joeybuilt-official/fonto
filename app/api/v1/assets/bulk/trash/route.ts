// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Bulk lifecycle mutation for the library multi-select.
//
//   POST /api/v1/assets/bulk/trash
//     Body: { ids: string[], restore?: boolean }
//     → trashes (or, with restore:true, un-trashes) every id the caller can
//       reach, in ONE request. Replaces the web/mobile "fire N parallel PATCH
//       /assets/{id}" pattern.
//
// Workspace-scoped + editor-gated. ids are filtered to the caller's own
// workspaces (IDOR guard) before any write, and each affected workspace is
// authz-checked for `editor`. Each mutated row gets a DISTINCT per-workspace
// seq (block-allocated in one atomic upsert, mirroring lib/db/seq.ts + the
// /scope/reassign batch path) so the delta-sync feed — which pages by
// `seq > cursor` — never drops a row that shared a seq value.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, inArray, sql } from "drizzle-orm";
import { pgArray } from "@/lib/db/sql-helpers";
import { cacheInvalidate } from "@/lib/cache/valkey";
import { parseJson } from "@/app/api/v1/_lib/parseJson";

// Cap on a single batch. A multi-select can span the whole visible grid; 1000
// matches the /assets list MAX_LIMIT so one screenful of selection always fits.
const MAX_IDS = 1000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const parsed = await parseJson<{ ids?: unknown; restore?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const ids = Array.isArray(body.ids)
    ? Array.from(
        new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length > 0))
      )
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Too many ids; max ${MAX_IDS} per request` },
      { status: 400 }
    );
  }
  const restore = body.restore === true;

  // Resolve only the ids the caller can actually reach (IDOR guard) and learn
  // which workspace each lives in so we can gate + seq-stamp per workspace.
  const rows = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(inArray(schema.assets.id, ids), inArray(schema.assets.workspaceId, workspaceIds))
    );
  if (rows.length === 0) {
    return NextResponse.json({ trashed: 0, restored: 0, requested: ids.length });
  }

  // Group the reachable ids by workspace. Almost always one workspace, but a
  // multi-workspace member could select across the shared boundary.
  const byWorkspace = new Map<string, string[]>();
  for (const r of rows) {
    const list = byWorkspace.get(r.workspaceId) ?? [];
    list.push(r.id);
    byWorkspace.set(r.workspaceId, list);
  }

  // Gate every affected workspace up front — bail on the first denial so a
  // partial write never lands.
  for (const wsId of byWorkspace.keys()) {
    const gate = await requireWorkspaceAccessOrResponse(user.id, wsId, "editor");
    if (!gate.ok) return gate.response;
  }

  const nextLifecycle = restore ? "active" : "trashed";
  const nextDeletedAt = restore ? null : new Date();

  let affected = 0;
  for (const [wsId, wsIds] of byWorkspace) {
    await db.transaction(async (tx) => {
      // Block-allocate N contiguous per-workspace asset seqs in one atomic
      // upsert (mirrors lib/db/seq.ts nextSeq incrementing by N). Block is
      // [firstSeq .. maxSeq].
      const N = wsIds.length;
      const seqRows = (await tx.execute(sql`
        INSERT INTO fonto.workspace_seq (workspace_id, asset_seq)
        VALUES (${wsId}, ${N})
        ON CONFLICT (workspace_id) DO UPDATE
          SET asset_seq = fonto.workspace_seq.asset_seq + ${N}
        RETURNING asset_seq AS seq
      `)) as unknown as Array<{ seq: string | number | bigint }>;
      const maxSeqRaw = seqRows[0]?.seq;
      if (maxSeqRaw == null) {
        throw new Error(`assets/bulk/trash: seq allocation returned no row for workspace=${wsId}`);
      }
      const maxSeq = typeof maxSeqRaw === "bigint" ? maxSeqRaw : BigInt(maxSeqRaw);
      const firstSeq = maxSeq - BigInt(N) + 1n;
      const seqs = wsIds.map((_, j) => (firstSeq + BigInt(j)).toString());

      // One UPDATE: lifecycle + deleted_at are constant across the batch; the
      // distinct per-row seq is joined in via unnest(ids, seqs).
      await tx.execute(sql`
        UPDATE fonto.assets AS a
        SET lifecycle_state = ${nextLifecycle},
            deleted_at = ${nextDeletedAt ? nextDeletedAt.toISOString() : null}::timestamptz,
            updated_at = now(),
            seq = v.seq
        FROM unnest(${pgArray(wsIds)}::uuid[], ${pgArray(seqs)}::bigint[]) AS v(id, seq)
        WHERE a.id = v.id AND a.workspace_id = ${wsId}
      `);
    });
    affected += wsIds.length;

    // T1.3' — evict every aggregate cache that embeds asset rows/counts.
    revalidateTag(`ws:${wsId}:assets`, "max");
    void cacheInvalidate(`ws:${wsId}:assets`);
  }

  return NextResponse.json(
    restore
      ? { restored: affected, trashed: 0, requested: ids.length }
      : { trashed: affected, restored: 0, requested: ids.length }
  );
}
