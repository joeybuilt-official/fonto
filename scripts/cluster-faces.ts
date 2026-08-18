// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — one-shot wrapper around `clusterWorkspaceFaces`. The HTTP
// route POST /api/v1/faces/cluster is owner-only and gated behind a
// browser session; this script lets us trigger the same clusterer from
// the CLI for backfills, smoke tests, and ad-hoc tuning of eps / minPts.
//
// Usage:
//   pnpm cluster:faces -- --workspace=<uuid>            # default eps/minPts
//   pnpm cluster:faces -- --workspace=<uuid> --eps=0.5 --min-pts=2
//   pnpm cluster:faces -- --all                          # every workspace
//
// Prints the {created, updated, noise} stats returned by the clusterer.
// Safe to re-run — clustering is idempotent (see lib/faces/cluster.ts).

import postgres from "postgres";
import { clusterWorkspaceFaces } from "@/lib/faces/cluster";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

async function listWorkspaces(): Promise<string[]> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = postgres(dbUrl, { prepare: false });
  try {
    const rows = (await sql`SELECT id FROM fonto.workspaces`) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const wsArg = arg("workspace");
  const allArg = arg("all");
  const epsRaw = arg("eps");
  const minPtsRaw = arg("min-pts") ?? arg("minPts");

  const opts: { eps?: number; minPts?: number } = {};
  if (typeof epsRaw === "string") {
    const n = Number.parseFloat(epsRaw);
    if (Number.isFinite(n) && n > 0 && n < 2) opts.eps = n;
  }
  if (typeof minPtsRaw === "string") {
    const n = Number.parseInt(minPtsRaw, 10);
    if (Number.isFinite(n) && n >= 2) opts.minPts = n;
  }

  let workspaces: string[];
  if (allArg) {
    workspaces = await listWorkspaces();
  } else if (typeof wsArg === "string") {
    workspaces = [wsArg];
  } else {
    console.error(
      "[cluster-faces] missing --workspace=<uuid> (or --all). " +
        "Optional: --eps=<0..2> --min-pts=<int>"
    );
    process.exit(2);
  }

  console.log(
    `[cluster-faces] start workspaces=${workspaces.length} eps=${opts.eps ?? "default"} minPts=${opts.minPts ?? "default"}`
  );

  for (const wsId of workspaces) {
    const t0 = Date.now();
    const stats = await clusterWorkspaceFaces(wsId, opts);
    const dt = Date.now() - t0;
    console.log(
      `[cluster-faces] ${wsId} created=${stats.created} updated=${stats.updated} noise=${stats.noise} (${dt}ms)`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[cluster-faces] fatal:", e);
    process.exit(1);
  });
