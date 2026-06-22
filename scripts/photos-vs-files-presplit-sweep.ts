// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos/Files split — pre-split classification sweep (thin wrapper).
//
// Re-derives KIND for exactly the rows that could otherwise land on the WRONG
// surface once LIBRARY_SURFACE_SPLIT_ENABLED flips on:
//
//   kind IS NULL                                  → Inbox today; want a real KIND
//   kind = 'moment' AND mime IN (png, gif)        → may belong on Files
//                                                    (screenshot / graphics)
//
// It is a THIN ORCHESTRATOR over scripts/classify-only-rerun.ts (--scope=presplit,
// which encodes that exact predicate). No classifier rules are touched here —
// classify-only-rerun reuses the SAME deriveKind/override helpers as live ingest
// (CLIP-only, cached clip_vec, no LLM, no re-OCR, no model cost).
//
// Chunking: each child invocation reclassifies up to --chunk (default 2000)
// matching rows. After a non-dry write, those rows no longer match the predicate
// (kind set / moment→screenshot|graphics), so the next invocation naturally
// picks up the next chunk. We loop until the child reports 0 candidates.
//
// Usage:
//   tsx scripts/photos-vs-files-presplit-sweep.ts --workspace-id=<uuid> [--dry-run] [--chunk=2000] [--max-chunks=100]
//
//   --dry-run     report-only; runs a SINGLE chunk and prints proposed changes
//                 (writes nothing, so the candidate set would never shrink —
//                 looping would never terminate, hence one pass).
//   --chunk=N     rows per child invocation (default 2000).
//   --max-chunks  hard safety cap on the number of chunks (default 100).
//
// DO NOT run while LIBRARY_SURFACE_SPLIT_ENABLED is ON in prod — a live sweep
// would make assets jump between Photos / Files / Inbox mid-session. Run it with
// the flag OFF, off-hours. See plans/photos-vs-files-split/plan.md §8.

import { spawn } from "node:child_process";
import path from "node:path";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!flag) return null;
  return flag.includes("=") ? flag.split("=")[1] : true;
}

const RERUN = path.join(__dirname, "classify-only-rerun.ts");

/**
 * Run one classify-only-rerun pass with --scope=presplit. Streams the child's
 * stdout/stderr through and resolves with the parsed candidate + changed counts.
 */
function runChunk(
  workspaceId: string,
  chunk: number,
  dryRun: boolean,
): Promise<{ candidates: number; changed: number; code: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      RERUN,
      `--workspace-id=${workspaceId}`,
      "--scope=presplit",
      `--limit=${chunk}`,
    ];
    if (dryRun) args.push("--dry-run");

    const child = spawn("tsx", args, { stdio: ["ignore", "pipe", "inherit"] });

    let candidates = 0;
    let changed = 0;
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      process.stdout.write(text); // pass through child progress
      buf += text;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const cand = buf.match(/candidates:\s*(\d+)/);
      if (cand) candidates = Number.parseInt(cand[1], 10);
      const chg = buf.match(/changed:\s*(\d+)/);
      if (chg) changed = Number.parseInt(chg[1], 10);
      resolve({ candidates, changed, code: code ?? 0 });
    });
  });
}

async function main(): Promise<void> {
  const workspaceId =
    typeof arg("workspace-id") === "string" ? (arg("workspace-id") as string) : null;
  if (!workspaceId) {
    console.error("ERROR: --workspace-id=<uuid> required (the Personal workspace).");
    process.exit(2);
  }
  const dryRun = !!arg("dry-run");
  const chunkArg = arg("chunk");
  const chunk =
    typeof chunkArg === "string" ? Math.max(1, Number.parseInt(chunkArg, 10)) : 2000;
  const maxChunksArg = arg("max-chunks");
  const maxChunks =
    typeof maxChunksArg === "string" ? Number.parseInt(maxChunksArg, 10) : 100;

  console.log(
    `[presplit-sweep] workspace=${workspaceId} chunk=${chunk} dryRun=${dryRun} maxChunks=${maxChunks}`,
  );

  if (dryRun) {
    console.log("[presplit-sweep] DRY RUN — single chunk, no writes.");
    const { candidates, changed, code } = await runChunk(workspaceId, chunk, true);
    console.log(
      `[presplit-sweep] DRY RUN done — candidates=${candidates} wouldChange=${changed} childExit=${code}`,
    );
    process.exit(code === 0 ? 0 : 1);
  }

  let totalChanged = 0;
  let totalProcessed = 0;
  for (let i = 0; i < maxChunks; i++) {
    console.log(`\n[presplit-sweep] === chunk ${i + 1}/${maxChunks} ===`);
    const { candidates, changed, code } = await runChunk(workspaceId, chunk, false);
    if (code !== 0) {
      console.error(`[presplit-sweep] child exited ${code} — stopping.`);
      process.exit(1);
    }
    totalChanged += changed;
    totalProcessed += candidates;
    console.log(
      `[presplit-sweep] chunk ${i + 1}: candidates=${candidates} changed=${changed} (running total changed=${totalChanged})`,
    );
    if (candidates < chunk) {
      // Last partial (or empty) chunk — the predicate is drained.
      console.log("[presplit-sweep] predicate drained.");
      break;
    }
    if (i === maxChunks - 1) {
      console.warn(
        "[presplit-sweep] hit --max-chunks cap with rows possibly remaining — re-run to continue.",
      );
    }
  }

  console.log(
    `\n[presplit-sweep] DONE — processed≈${totalProcessed} changed=${totalChanged}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[presplit-sweep] fatal:", err);
  process.exit(1);
});
