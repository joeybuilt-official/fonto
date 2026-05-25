// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto sync <dir>` — one-way (local → remote) incremental upload.
//
// Walks <dir> recursively. For each file:
//   1. Stat (mtime, size). If unchanged vs. the state file, skip.
//   2. Otherwise SHA-256 the bytes. If hash matches the state file
//      record, refresh the mtime in the state and skip the upload (the
//      file was touch'd but not edited).
//   3. Otherwise upload via POST /api/v1/assets with the X-Fonto-Path
//      header set to the file's parent directory relative to <dir>,
//      prefixed by --remote-prefix (default `/`). Record the resulting
//      assetId in the state.
//
// State file lives at <dir>/.fonto-sync.json by default; --state <path>
// overrides. Format is a flat map keyed by the relative path so it's
// easy to inspect and diff.
//
// Ignores: hard-coded `.git`, `node_modules`, `.DS_Store`, `Thumbs.db`,
// plus anything listed in <dir>/.fontoignore (one glob per line, # for
// comments). Glob matching is intentionally simple — `*` matches any
// run of non-`/` chars, `**` matches across separators. No `!`-negation.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import chalk from "chalk";
import ora from "ora";
import { getConfig } from "../config.js";
import { ApiError } from "../api.js";

export interface SyncOpts {
  remotePrefix?: string;
  state?: string;
  dryRun?: boolean;
  concurrency?: string;
}

interface StateEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
  assetId: string | null;
  uploadedAt: string;
}

type SyncState = Record<string, StateEntry>;

const HARD_IGNORE = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db", ".fonto-sync.json"]);

function loadState(p: string): SyncState {
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SyncState;
  } catch {
    console.warn(chalk.yellow(`! state file at ${p} is corrupt — starting fresh`));
    return {};
  }
}

function saveState(p: string, state: SyncState): void {
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function loadIgnoreFile(dir: string): RegExp[] {
  const f = path.join(dir, ".fontoignore");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(globToRegex);
}

function globToRegex(glob: string): RegExp {
  // Translate `**`, `*`, `?` into regex. Anchored, no `!` negation. The
  // leading `^` plus the trailing `$` keep the match exact against the
  // full repo-relative path.
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+()[]{}|^$\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

function isIgnored(relPath: string, name: string, patterns: RegExp[]): boolean {
  if (HARD_IGNORE.has(name)) return true;
  return patterns.some((re) => re.test(relPath));
}

interface WalkedFile {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

function walk(rootDir: string, patterns: RegExp[]): WalkedFile[] {
  const out: WalkedFile[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const ents = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of ents) {
      const abs = path.join(cur, ent.name);
      const rel = path.relative(rootDir, abs);
      if (isIgnored(rel, ent.name, patterns)) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        const st = fs.statSync(abs);
        out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("end", () => resolve(h.digest("hex")));
    stream.on("error", reject);
  });
}

async function uploadOne(
  file: WalkedFile,
  remoteDirPrefix: string
): Promise<{ assetId: string | null; deduplicated: boolean }> {
  const cfg = getConfig();
  if (!cfg.pat) throw new Error("No PAT — run `fonto login --pat <token>` first.");

  // Virtual remote path is <remotePrefix>/<rel-dir>, normalised so a
  // remote prefix of "/" + relDir of "" collapses to "/".
  const relDir = path.dirname(file.rel).replace(/\\/g, "/");
  const composed =
    remoteDirPrefix.replace(/\/+$/, "") +
    (relDir === "." ? "" : "/" + relDir);
  const remotePath = composed === "" ? "/" : composed;

  const buffer = await fs.promises.readFile(file.abs);
  const blob = new Blob([new Uint8Array(buffer)]);
  const form = new FormData();
  form.set("file", blob, path.basename(file.abs));
  form.set("source", "cli-sync");

  const res = await fetch(`${cfg.baseUrl}/api/v1/assets`, {
    method: "POST",
    body: form,
    headers: {
      Authorization: `Bearer ${cfg.pat}`,
      "X-Fonto-Path": remotePath,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, text, message);
  }
  const body = JSON.parse(text) as {
    asset: { id: string };
    deduplicated?: boolean;
  };
  return { assetId: body.asset.id, deduplicated: !!body.deduplicated };
}

export async function sync(dir: string, opts: SyncOpts): Promise<void> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(chalk.red(`✗ not a directory: ${dir}`));
    process.exitCode = 2;
    return;
  }
  const rootDir = path.resolve(dir);
  const statePath = opts.state ?? path.join(rootDir, ".fonto-sync.json");
  const remotePrefix = (opts.remotePrefix ?? "/").replace(/\/+$/, "") || "/";

  const patterns = loadIgnoreFile(rootDir);
  const state = loadState(statePath);

  const spin = ora("Walking…").start();
  const files = walk(rootDir, patterns);
  spin.text = `${files.length} files indexed — diffing…`;

  // Bucket files into skip / hash-then-skip / upload using stat first
  // (cheap), only hashing when the cached stat doesn't match.
  const upload: WalkedFile[] = [];
  let stale = 0;
  for (const f of files) {
    const prev = state[f.rel];
    if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs && prev.assetId) {
      // Unchanged on disk — trust state.
      continue;
    }
    if (prev && prev.size === f.size) {
      // Same size, different mtime. Hash to be sure.
      const h = await sha256(f.abs);
      if (h === prev.sha256 && prev.assetId) {
        state[f.rel] = { ...prev, mtimeMs: f.mtimeMs };
        stale++;
        continue;
      }
    }
    upload.push(f);
  }

  spin.succeed(
    `${upload.length} to upload, ${stale} touch-only refreshed, ${files.length - upload.length - stale} unchanged`
  );

  if (opts.dryRun) {
    for (const f of upload.slice(0, 20)) console.log(chalk.dim(`  + ${f.rel}`));
    if (upload.length > 20) console.log(chalk.dim(`  …and ${upload.length - 20} more`));
    saveState(statePath, state);
    return;
  }

  if (upload.length === 0) {
    saveState(statePath, state);
    console.log(chalk.green("✓ in sync"));
    return;
  }

  let ok = 0;
  let dedupe = 0;
  let fail = 0;
  // Sequential upload — keeps the request budget predictable and avoids
  // hammering the Plexo classifier on a fresh seed. A future flag can
  // bump this; the simplest correct shape ships first.
  for (let i = 0; i < upload.length; i++) {
    const f = upload[i];
    const s = ora(`[${i + 1}/${upload.length}] ${f.rel}`).start();
    try {
      const { assetId, deduplicated } = await uploadOne(f, remotePrefix);
      const sha = await sha256(f.abs);
      state[f.rel] = {
        size: f.size,
        mtimeMs: f.mtimeMs,
        sha256: sha,
        assetId,
        uploadedAt: new Date().toISOString(),
      };
      if (deduplicated) {
        dedupe++;
        s.warn(`${f.rel} ${chalk.dim("(dedup)")}`);
      } else {
        ok++;
        s.succeed(`${f.rel} ${chalk.dim(assetId?.slice(0, 8) ?? "")}`);
      }
      // Persist state per file so an interrupted sync doesn't re-upload
      // every successful file on restart.
      saveState(statePath, state);
    } catch (err) {
      fail++;
      if (err instanceof ApiError) {
        s.fail(`${f.rel} ${chalk.dim(`${err.status} ${err.message}`)}`);
      } else {
        s.fail(`${f.rel} ${chalk.dim((err as Error).message)}`);
      }
    }
  }

  console.log(
    chalk.dim(
      `${ok} uploaded, ${dedupe} deduped, ${fail} failed (state saved → ${statePath})`
    )
  );
  if (fail > 0) process.exitCode = 1;
}
