// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot verifier for the immich→fonto delete gate. For every source file
// the import manifest marked inserted/deduplicated, confirm:
//   1. an ACTIVE asset row with that SHA-256 exists in the workspace,
//   2. its sync_state is 'synced',
//   3. r2().stat(key) succeeds  (bytes in R2),
//   4. localFs().stat(key) succeeds  (bytes in the local mirror).
// A source file is "delete-safe" iff all four hold. Anything else is reported
// and gates the delete.
//
// Usage (manifest mode — trusts the import manifest):
//   tsx scripts/verify-immich-batch.mts --manifest=<path> --workspace=<uuid>
//
// Usage (source-truth mode — re-hashes every source file, ignores the manifest):
//   tsx scripts/verify-immich-batch.mts --source-root=<dir> --workspace=<uuid> [--concurrency=N]
//
// Source-truth mode is the airtight delete gate: it walks the source dir with the
// SAME filters as the importer (skip dotfiles / .xmp / 0-byte), SHA-256s each file,
// and confirms a delete-safe Fonto asset exists for that SHA. Unlike manifest mode
// it cannot be fooled by lost manifest lines or files whose last manifest entry is
// "error" — every byte on disk is checked. Use this when a batch's manifest is
// polluted (duplicates / errors) or whenever you want maximum assurance before rm.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";

function arg(name: string): string | null {
  const f = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  return f === `--${name}` ? "" : f.split("=").slice(1).join("=");
}

interface Line {
  path: string;
  sha256: string;
  outcome: string;
}

// Same walk + filter as the importer: skip dotfiles/dotdirs + .xmp sidecars.
function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && path.extname(e.name).toLowerCase() !== ".xmp") out.push(full);
    }
  }
  return out;
}

// Resolve {path, sha256} targets from either a polluted manifest (trust mode) or
// by re-hashing every source file (source-truth mode).
function manifestTargets(manifestPath: string): { path: string; sha256: string }[] {
  // Last line per path wins (a re-imported file supersedes its earlier error).
  const byPath = new Map<string, Line>();
  for (const raw of fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(raw) as Line;
      byPath.set(e.path, e);
    } catch {
      /* skip */
    }
  }
  return [...byPath.values()]
    .filter((e) => e.outcome === "inserted" || e.outcome === "deduplicated")
    .map((e) => ({ path: e.path, sha256: e.sha256 }));
}

function sourceTargets(root: string): { path: string; sha256: string }[] {
  const files = walk(root);
  const out: { path: string; sha256: string }[] = [];
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(f);
    } catch {
      // Unreadable source — treat as a target so it surfaces as missingRow (gate stays closed).
      out.push({ path: f, sha256: "" });
      continue;
    }
    if (buf.length === 0) continue; // importer skips 0-byte
    out.push({ path: f, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
  }
  return out;
}

async function main(): Promise<void> {
  const manifestPath = arg("manifest");
  const sourceRoot = arg("source-root");
  const workspaceId = arg("workspace");
  if (!manifestPath && !sourceRoot)
    throw new Error("one of --manifest=<path> or --source-root=<dir> required");
  if (!workspaceId) throw new Error("--workspace=<uuid> required");

  const mode = sourceRoot ? "source-truth" : "manifest";
  const emitUnsafe = arg("emit-unsafe");
  const targets = sourceRoot ? sourceTargets(sourceRoot) : manifestTargets(manifestPath!);
  console.log(`[verify] mode=${mode} targets=${targets.length}`);

  // An empty target set is NOT a pass — it usually means the source dir is already
  // gone/empty, which must never be reported as "delete-safe". Fail loudly so a
  // caller can't mistake a vacuous zero for a verified batch.
  if (targets.length === 0) {
    console.log(`\n[verify] RESULT: EMPTY — no source files to verify (dir gone/empty?). Gate stays closed.`);
    process.exit(3);
  }

  let ok = 0;
  const missingRow: string[] = [];
  const notSynced: string[] = [];
  const missingR2: string[] = [];
  const missingLocal: string[] = [];
  const unsafeShas = new Set<string>();

  let i = 0;
  for (const t of targets) {
    i++;
    const [row] = t.sha256
      ? await db
          .select({
            id: schema.assets.id,
            filename: schema.assets.filename,
            syncState: schema.assets.syncState,
          })
          .from(schema.assets)
          .where(
            and(
              eq(schema.assets.workspaceId, workspaceId),
              eq(schema.assets.sha256, t.sha256),
              eq(schema.assets.lifecycleState, "active")
            )
          )
          .limit(1)
      : [undefined];
    if (!row) {
      missingRow.push(t.path);
      if (t.sha256) unsafeShas.add(t.sha256);
      continue;
    }
    if (row.syncState !== "synced") notSynced.push(`${t.path} (${row.syncState})`);

    const key = assetStorageKey(workspaceId, row.id, row.filename);
    let r2ok = false;
    let localOk = false;
    try {
      await r2().stat(key);
      r2ok = true;
    } catch {
      missingR2.push(t.path);
    }
    try {
      await localFs().stat(key);
      localOk = true;
    } catch {
      missingLocal.push(t.path);
    }
    if (row.syncState === "synced" && r2ok && localOk) ok++;
    else if (t.sha256) unsafeShas.add(t.sha256);
    if (i % 100 === 0) console.log(`[verify] checked ${i}/${targets.length} ok=${ok}`);
  }

  const safe = ok === targets.length;
  console.log(`\n[verify] ${mode} targets: ${targets.length}`);
  console.log(`[verify] delete-safe (row+synced+r2+local): ${ok}`);
  console.log(`[verify] missingRow=${missingRow.length} notSynced=${notSynced.length} missingR2=${missingR2.length} missingLocal=${missingLocal.length}`);
  for (const [label, arr] of [
    ["MISSING-ROW", missingRow],
    ["NOT-SYNCED", notSynced],
    ["MISSING-R2", missingR2],
    ["MISSING-LOCAL", missingLocal],
  ] as const) {
    if (arr.length) console.log(`\n[verify] ${label}:\n${arr.slice(0, 50).join("\n")}`);
  }
  if (!safe && emitUnsafe) {
    fs.writeFileSync(emitUnsafe, [...unsafeShas].join("\n") + "\n");
    console.log(`\n[verify] wrote ${unsafeShas.size} not-safe sha256 → ${emitUnsafe}`);
  }
  console.log(`\n[verify] RESULT: ${safe ? "ALL DELETE-SAFE" : "NOT SAFE — gate stays closed"}`);
  process.exit(safe ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
