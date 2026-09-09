// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// D1 resolution — soft-delete the 5 PNG screenshots with no recoverable
// original anywhere (no import manifest, no local trace, no R2 trace; R2
// versioning is Disabled so no bucket-side recovery window exists either).
// See docs/claude/platform/consolidation-2026-09/plan.md, decision D1.
//
// Runs the IDENTICAL lifecycle transaction POST /api/v1/assets/bulk/trash
// uses (app/api/v1/assets/bulk/trash/route.ts): per-workspace seq
// block-allocation + lifecycle_state='trashed' + deleted_at=now() in one
// transaction, so the delta-sync feed and every other trash side effect
// behave exactly as if a user had trashed them from the library UI. This is
// an operator/admin script (no HTTP session exists for a one-off recovery
// run) so it re-runs the route's own SQL directly against the same `db`
// client rather than a hand-rolled UPDATE.
//
// Usage:
//   tsx scripts/d1-trash-pngs.ts --dry-run
//   tsx scripts/d1-trash-pngs.ts --apply

import { sql, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { pgArray } from "@/lib/db/sql-helpers";

const ASSET_IDS = [
  "6d175fe0-0f28-4e07-9d35-ca30e47f9748",
  "940123d0-b2a8-4fbf-a2d5-afb9dfabb0a7",
  "13efb228-2149-4046-8c74-573c2f27bd98",
  "269b3b5e-9999-4d7e-816c-3ea84bd7f6ac",
  "13b3bc40-4b3f-4154-aea3-d26d41fc0210",
];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const apply = flag("apply");

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      lifecycleState: schema.assets.lifecycleState,
    })
    .from(schema.assets)
    .where(inArray(schema.assets.id, ASSET_IDS));

  if (rows.length !== ASSET_IDS.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ASSET_IDS.filter((id) => !found.has(id));
    throw new Error(`d1-trash-pngs: ${missing.length} id(s) not found: ${missing.join(", ")}`);
  }

  const byWorkspace = new Map<string, string[]>();
  for (const r of rows) {
    const list = byWorkspace.get(r.workspaceId) ?? [];
    list.push(r.id);
    byWorkspace.set(r.workspaceId, list);
  }

  console.log(`plan: trash ${rows.length} asset(s) across ${byWorkspace.size} workspace(s)`);
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.filename}  lifecycle=${r.lifecycleState}`);
  }

  if (!apply) {
    console.log("dry run — no writes. Re-run with --apply to execute.");
    return;
  }

  let affected = 0;
  for (const [wsId, wsIds] of byWorkspace) {
    await db.transaction(async (tx) => {
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
        throw new Error(`d1-trash-pngs: seq allocation returned no row for workspace=${wsId}`);
      }
      const maxSeq = typeof maxSeqRaw === "bigint" ? maxSeqRaw : BigInt(maxSeqRaw);
      const firstSeq = maxSeq - BigInt(N) + 1n;
      const seqs = wsIds.map((_, j) => (firstSeq + BigInt(j)).toString());

      await tx.execute(sql`
        UPDATE fonto.assets AS a
        SET lifecycle_state = 'trashed',
            deleted_at = now(),
            updated_at = now(),
            seq = v.seq
        FROM unnest(${pgArray(wsIds)}::uuid[], ${pgArray(seqs)}::bigint[]) AS v(id, seq)
        WHERE a.id = v.id AND a.workspace_id = ${wsId}
      `);
    });
    affected += wsIds.length;
  }

  console.log(`trashed ${affected} asset(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
