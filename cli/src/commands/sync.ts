// SPDX-License-Identifier: MIT
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
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import chalk from "chalk";
import ora from "ora";
import { getConfig } from "../config.js";
import { ApiError } from "../api.js";

export interface SyncOpts {
  remotePrefix?: string;
  state?: string;
  dryRun?: boolean;
  concurrency?: string;
  pull?: boolean;
}

interface StateEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
  assetId: string | null;
  uploadedAt: string;
}

// v1 (pre-0.3.0): flat map { relPath → StateEntry }.
// v2: { version, cursor, entries }. Cursor tracks the highest seq seen
// by `sync --pull` so the next pull only reads new deltas. Loader
// migrates v1 in-place; saver always writes v2.
interface SyncStateV2 {
  version: 2;
  cursor: string;
  entries: Record<string, StateEntry>;
  // M9 — in-progress resumable (tus) uploads: relPath → tus upload URL. An
  // entry here means a large upload was started but not finished; the next run
  // HEADs the URL and continues from the server-reported offset. Cleared on
  // completion.
  tusResume?: Record<string, string>;
}

type SyncState = SyncStateV2;

const HARD_IGNORE = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db", ".fonto-sync.json"]);

function emptyState(): SyncState {
  return { version: 2, cursor: "0", entries: {}, tusResume: {} };
}

// M9 — files at/above this size upload via the resumable tus protocol instead
// of the single-shot multipart POST (which the server caps at 50MB and which
// can't resume a dropped connection). 50MB matches that server cap.
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
// Match the server's S3 multipart part size (lib/tus/server.ts PART_SIZE_BYTES).
const TUS_CHUNK_BYTES = 8 * 1024 * 1024;

function loadState(p: string): SyncState {
  if (!fs.existsSync(p)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (raw && typeof raw === "object" && (raw as SyncStateV2).version === 2) {
      const v2 = raw as SyncStateV2;
      return {
        version: 2,
        cursor: typeof v2.cursor === "string" ? v2.cursor : "0",
        entries: v2.entries ?? {},
        tusResume: v2.tusResume ?? {},
      };
    }
    // v1 — flat map. Wrap.
    return { version: 2, cursor: "0", entries: raw as Record<string, StateEntry> };
  } catch {
    console.warn(chalk.yellow(`! state file at ${p} is corrupt — starting fresh`));
    return emptyState();
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
  if (!cfg.baseUrl) {
    throw new Error(
      "No Fonto instance configured — run `fonto login --base-url <url> --pat <token>` first."
    );
  }
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

function tusMetadata(filename: string, mimeType: string, remotePath: string): string {
  const enc = (v: string) => Buffer.from(v, "utf8").toString("base64");
  return [
    `filename ${enc(filename)}`,
    `filetype ${enc(mimeType)}`,
    `path ${enc(remotePath)}`,
  ].join(",");
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * M9 — resumable large-file upload over the tus protocol, dependency-free.
 * Persists the tus upload URL in the state file so an interrupted run resumes
 * from the server-reported offset on the next invocation. Returns the asset id
 * (from the final response's X-Fonto-Asset-Id header).
 */
async function uploadOneTus(
  file: WalkedFile,
  remotePath: string,
  state: SyncState,
  statePath: string
): Promise<{ assetId: string | null; deduplicated: boolean }> {
  const cfg = getConfig();
  if (!cfg.baseUrl) {
    throw new Error(
      "No Fonto instance configured — run `fonto login --base-url <url> --pat <token>` first."
    );
  }
  if (!cfg.pat) throw new Error("No PAT — run `fonto login --pat <token>` first.");
  const auth = { Authorization: `Bearer ${cfg.pat}`, "Tus-Resumable": "1.0.0" };
  const filename = path.basename(file.abs);
  state.tusResume ??= {};

  // Reuse a stored URL if a prior run started this file.
  let url: string | null = state.tusResume[file.rel] ?? null;
  let offset = 0;
  if (url) {
    const head = await fetch(url, { method: "HEAD", headers: auth });
    if (head.ok) {
      offset = Number(head.headers.get("Upload-Offset") ?? "0") || 0;
    } else {
      url = null; // expired/unknown — recreate
    }
  }

  // Create the upload if we don't have a live URL.
  if (!url) {
    const create = await fetch(`${cfg.baseUrl}/api/v1/uploads/tus`, {
      method: "POST",
      headers: {
        ...auth,
        "Upload-Length": String(file.size),
        "Upload-Metadata": tusMetadata(filename, guessMime(filename), remotePath),
        "Content-Length": "0",
      },
    });
    if (create.status !== 201) {
      const text = await create.text();
      throw new ApiError(create.status, text, `tus create ${create.status}`);
    }
    const loc = create.headers.get("Location");
    if (!loc) throw new Error("tus create returned no Location");
    url = new URL(loc, cfg.baseUrl).toString();
    offset = 0;
    state.tusResume[file.rel] = url;
    saveState(statePath, state);
  }

  // PATCH sequential chunks from the current offset to EOF.
  let assetId: string | null = null;
  const fh = await fs.promises.open(file.abs, "r");
  try {
    while (offset < file.size) {
      const len = Math.min(TUS_CHUNK_BYTES, file.size - offset);
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, offset);
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          ...auth,
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(offset),
        },
        body: new Uint8Array(buf),
      });
      if (res.status !== 204 && res.status !== 200) {
        const text = await res.text();
        throw new ApiError(res.status, text, `tus PATCH ${res.status}`);
      }
      offset = Number(res.headers.get("Upload-Offset") ?? String(offset + len));
      const idHeader = res.headers.get("X-Fonto-Asset-Id");
      if (idHeader) assetId = idHeader;
    }
  } finally {
    await fh.close();
  }

  // Done — drop the resume marker.
  delete state.tusResume[file.rel];
  saveState(statePath, state);
  return { assetId, deduplicated: false };
}

// Upload one file (large → resumable tus, else multipart), then record it in
// the state file and persist. Shared by the one-shot `sync` loop and the
// `watch` daemon. Throws on failure; caller handles logging.
async function uploadAndRecord(
  f: WalkedFile,
  remotePrefix: string,
  state: SyncState,
  statePath: string
): Promise<{ assetId: string | null; deduplicated: boolean }> {
  const relDir = path.dirname(f.rel).replace(/\\/g, "/");
  const composed = remotePrefix.replace(/\/+$/, "") + (relDir === "." ? "" : "/" + relDir);
  const remotePath = composed === "" ? "/" : composed;
  const { assetId, deduplicated } =
    f.size >= LARGE_FILE_BYTES
      ? await uploadOneTus(f, remotePath, state, statePath)
      : await uploadOne(f, remotePrefix);
  const sha = await sha256(f.abs);
  state.entries[f.rel] = {
    size: f.size,
    mtimeMs: f.mtimeMs,
    sha256: sha,
    assetId,
    uploadedAt: new Date().toISOString(),
  };
  saveState(statePath, state);
  return { assetId, deduplicated };
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

  const state = loadState(statePath);

  // --pull pulls remote deltas first, then falls through to the push
  // pass. This ordering means a freshly-pulled asset is already in the
  // state file by the time push diffs the tree, so it won't be re-
  // uploaded.
  if (opts.pull) {
    await runPull(rootDir, statePath, remotePrefix, state, opts);
  }

  const patterns = loadIgnoreFile(rootDir);
  const spin = ora("Walking…").start();
  const files = walk(rootDir, patterns);
  spin.text = `${files.length} files indexed — diffing…`;

  // Bucket files into skip / hash-then-skip / upload using stat first
  // (cheap), only hashing when the cached stat doesn't match.
  const upload: WalkedFile[] = [];
  let stale = 0;
  for (const f of files) {
    const prev = state.entries[f.rel];
    if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs && prev.assetId) {
      // Unchanged on disk — trust state.
      continue;
    }
    if (prev && prev.size === f.size) {
      // Same size, different mtime. Hash to be sure.
      const h = await sha256(f.abs);
      if (h === prev.sha256 && prev.assetId) {
        state.entries[f.rel] = { ...prev, mtimeMs: f.mtimeMs };
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
  // hammering the AI classifier on a fresh seed. A future flag can
  // bump this; the simplest correct shape ships first.
  for (let i = 0; i < upload.length; i++) {
    const f = upload[i];
    const s = ora(`[${i + 1}/${upload.length}] ${f.rel}`).start();
    try {
      // Large files take the resumable tus path; state is persisted per file
      // inside the helper so an interrupted sync doesn't re-upload everything.
      const { assetId, deduplicated } = await uploadAndRecord(f, remotePrefix, state, statePath);
      if (deduplicated) {
        dedupe++;
        s.warn(`${f.rel} ${chalk.dim("(dedup)")}`);
      } else {
        ok++;
        s.succeed(`${f.rel} ${chalk.dim(assetId?.slice(0, 8) ?? "")}`);
      }
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

// ──────────────────────────────────────────────────────────────────────
// Pull side. Walks /api/v1/sync/assets?cursor= forward until hasMore is
// false, materialises:
//   - tombstones → remove local file + state entry
//   - upserts    → download original to <rootDir>/<rel>, refresh state
//
// Mapping rule: an upsert's directoryPath must start with remotePrefix
// to enter our local tree. The leftover (after stripping the prefix) is
// the local sub-directory; filename is appended.
//
// Conflict policy: if a target local path already exists AND is not the
// tracked file for this asset, we skip + warn rather than clobber. The
// next push will then upload the local file as its own asset (or hit
// dedup if the bytes match).

interface PullAsset {
  id: string;
  filename: string;
  directoryPath: string | null;
  sizeBytes: number;
}

interface PullPage {
  entries: Array<
    | { op: "delete"; id: string; seq: string }
    | { op: "upsert"; seq: string; asset: PullAsset }
  >;
  nextCursor: string;
  hasMore: boolean;
}

interface PullPlanItem {
  rel: string;
  asset: PullAsset;
}

function relForAsset(asset: PullAsset, remotePrefix: string): string | null {
  if (asset.directoryPath == null) {
    return remotePrefix === "/" ? asset.filename : null;
  }
  if (remotePrefix === "/") {
    const sub = asset.directoryPath.replace(/^\//, "");
    return sub ? `${sub}/${asset.filename}` : asset.filename;
  }
  if (asset.directoryPath === remotePrefix) {
    return asset.filename;
  }
  if (asset.directoryPath.startsWith(`${remotePrefix}/`)) {
    const sub = asset.directoryPath.slice(remotePrefix.length).replace(/^\//, "");
    return `${sub}/${asset.filename}`;
  }
  return null;
}

function findRelByAssetId(state: SyncState, id: string): string | null {
  for (const [rel, e] of Object.entries(state.entries)) {
    if (e.assetId === id) return rel;
  }
  return null;
}

async function runPull(
  rootDir: string,
  statePath: string,
  remotePrefix: string,
  state: SyncState,
  opts: SyncOpts
): Promise<void> {
  const { request } = await import("../api.js");
  const cfg = (await import("../config.js")).getConfig();
  if (!cfg.baseUrl) {
    throw new Error(
      "No Fonto instance configured — run `fonto login --base-url <url> --pat <token>` first."
    );
  }
  if (!cfg.pat) throw new Error("No PAT — run `fonto login --pat <token>` first.");

  const spin = ora(`Pulling from cursor=${state.cursor}…`).start();

  const deletes: string[] = []; // asset ids
  const downloads: PullPlanItem[] = [];
  let conflicts = 0;
  let upserts = 0;
  let cursor = state.cursor;

  for (;;) {
    const page = await request<PullPage>(
      `/api/v1/sync/assets?cursor=${encodeURIComponent(cursor)}&limit=500`
    );
    for (const entry of page.entries) {
      if (entry.op === "delete") {
        deletes.push(entry.id);
      } else {
        upserts++;
        const rel = relForAsset(entry.asset, remotePrefix);
        if (!rel) continue; // outside our sync zone
        const prev = state.entries[rel];
        const target = path.join(rootDir, rel);
        if (
          prev &&
          prev.assetId === entry.asset.id &&
          prev.size === entry.asset.sizeBytes
        ) {
          continue; // already present locally
        }
        if (fs.existsSync(target) && !(prev && prev.assetId === entry.asset.id)) {
          conflicts++;
          continue; // would clobber an untracked local file
        }
        downloads.push({ rel, asset: entry.asset });
      }
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
    spin.text = `Pulling from cursor=${cursor} (${upserts} upserts, ${deletes.length} deletes seen)…`;
  }
  spin.succeed(
    `${downloads.length} to download, ${deletes.length} to delete, ${conflicts} conflicts skipped, cursor → ${cursor}`
  );

  if (opts.dryRun) {
    for (const d of downloads.slice(0, 10)) console.log(chalk.dim(`  ↓ ${d.rel}`));
    if (downloads.length > 10)
      console.log(chalk.dim(`  …and ${downloads.length - 10} more`));
    for (const id of deletes.slice(0, 5))
      console.log(chalk.dim(`  ✗ ${id.slice(0, 8)}`));
    return;
  }

  // Apply deletes first — `rel`s freed up here may be reused by an
  // incoming download in the same pass.
  for (const id of deletes) {
    const rel = findRelByAssetId(state, id);
    if (!rel) continue;
    const local = path.join(rootDir, rel);
    try {
      if (fs.existsSync(local)) fs.unlinkSync(local);
    } catch (err) {
      console.warn(chalk.yellow(`! could not delete ${rel}: ${(err as Error).message}`));
    }
    delete state.entries[rel];
  }
  if (deletes.length) saveState(statePath, state);

  // Resolve URLs in batches of 50, stream each presigned URL to disk.
  for (let i = 0; i < downloads.length; i += 50) {
    const chunk = downloads.slice(i, i + 50);
    const ids = chunk.map((d) => d.asset.id);
    const batch = await request<{ urls: Record<string, string> }>(
      `/api/v1/assets/urls`,
      {
        method: "POST",
        body: JSON.stringify({ ids, variant: "original" }),
      }
    );
    for (let j = 0; j < chunk.length; j++) {
      const d = chunk[j];
      const idx = i + j + 1;
      const s = ora(`[${idx}/${downloads.length}] ${d.rel}`).start();
      const url = batch.urls[d.asset.id];
      if (!url) {
        s.fail(`${d.rel} ${chalk.dim("(no URL — deleted between pages?)")}`);
        continue;
      }
      try {
        const target = path.join(rootDir, d.rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const res = await fetch(url, {
          headers: { "User-Agent": `fonto-cli (${cfg.baseUrl})` },
        });
        if (!res.ok || !res.body) {
          s.fail(`${d.rel} ${chalk.dim(`${res.status} ${res.statusText}`)}`);
          continue;
        }
        const file = fs.createWriteStream(target);
        const nodeStream = Readable.fromWeb(
          res.body as NodeReadableStream<Uint8Array>
        );
        await pipeline(nodeStream, file);
        const sha = await sha256(target);
        const stat = fs.statSync(target);
        state.entries[d.rel] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: sha,
          assetId: d.asset.id,
          uploadedAt: new Date().toISOString(),
        };
        // Persist per-file so an interrupted pull restarts cleanly. We
        // bump the cursor only after the full pass succeeds — better to
        // re-see a few entries than to skip a download on crash.
        saveState(statePath, state);
        s.succeed(`${d.rel} ${chalk.dim(d.asset.id.slice(0, 8))}`);
      } catch (err) {
        s.fail(`${d.rel} ${chalk.dim((err as Error).message)}`);
      }
    }
  }

  state.cursor = cursor;
  saveState(statePath, state);
}

// ──────────────────────────────────────────────────────────────────────
// M11 — `fonto watch <dir>`: long-running push daemon. Runs a one-shot sync to
// establish a baseline, then watches the tree and uploads new/changed files as
// they settle — no need to re-run `sync`. Dependency-free (fs.watch + debounce
// + a stability re-stat), mirroring the dependency-free tus path above.
// Push-only: deletions + pulls are out of scope (use `sync --pull` for bidir).

export interface WatchOpts extends SyncOpts {
  debounce?: string;
}

export async function watch(dir: string, opts: WatchOpts): Promise<void> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(chalk.red(`✗ not a directory: ${dir}`));
    process.exitCode = 2;
    return;
  }
  const rootDir = path.resolve(dir);
  const statePath = opts.state ?? path.join(rootDir, ".fonto-sync.json");
  const remotePrefix = (opts.remotePrefix ?? "/").replace(/\/+$/, "") || "/";
  const debounceMs = Math.max(200, Number(opts.debounce ?? "800") || 800);

  // Establish a baseline first — uploads everything already present, then we
  // only react to changes from here.
  await sync(dir, opts);

  // Reload the state the baseline pass just wrote; the watcher mutates this.
  const state = loadState(statePath);
  const patterns = loadIgnoreFile(rootDir);

  // Per-path debounce timers + a single-flight FIFO queue so uploads run one at
  // a time (matches sync's sequential default; predictable request budget).
  const pending = new Map<string, NodeJS.Timeout>();
  const queue: string[] = [];
  let draining = false;

  async function processRel(rel: string): Promise<void> {
    const abs = path.join(rootDir, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return; // gone before we got to it — push-only, nothing to do
    }
    if (!st.isFile()) return;

    // Stability check: re-stat after a beat. If the file is still changing
    // (mid-write / large copy), bail — a later event re-triggers it.
    await new Promise((r) => setTimeout(r, 250));
    let st2: fs.Stats;
    try {
      st2 = fs.statSync(abs);
    } catch {
      return;
    }
    if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs) return;

    const f: WalkedFile = { abs, rel, size: st2.size, mtimeMs: st2.mtimeMs };
    const prev = state.entries[rel];
    if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs && prev.assetId) return;
    if (prev && prev.size === f.size) {
      const h = await sha256(abs);
      if (h === prev.sha256 && prev.assetId) {
        state.entries[rel] = { ...prev, mtimeMs: f.mtimeMs };
        saveState(statePath, state);
        return;
      }
    }
    const s = ora(`↑ ${rel}`).start();
    try {
      const { assetId, deduplicated } = await uploadAndRecord(f, remotePrefix, state, statePath);
      if (deduplicated) s.warn(`${rel} ${chalk.dim("(dedup)")}`);
      else s.succeed(`${rel} ${chalk.dim(assetId?.slice(0, 8) ?? "")}`);
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status} ${err.message}` : (err as Error).message;
      s.fail(`${rel} ${chalk.dim(msg)}`);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const rel = queue.shift()!;
      await processRel(rel);
    }
    draining = false;
  }

  function schedule(rel: string): void {
    const existing = pending.get(rel);
    if (existing) clearTimeout(existing);
    pending.set(
      rel,
      setTimeout(() => {
        pending.delete(rel);
        if (!queue.includes(rel)) queue.push(rel);
        void drain();
      }, debounceMs)
    );
  }

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(rootDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(path.sep).join("/");
      if (isIgnored(rel, path.basename(rel), patterns)) return;
      schedule(rel);
    });
  } catch (err) {
    console.error(
      chalk.red(
        `✗ could not start watcher: ${(err as Error).message}\n` +
          `  Recursive fs.watch needs Node ≥ 20 on Linux. Re-run \`fonto sync\` periodically instead.`
      )
    );
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green(`👁  watching ${rootDir} → ${remotePrefix}  (Ctrl-C to stop)`));

  await new Promise<void>((resolve) => {
    const stop = () => {
      watcher.close();
      for (const t of pending.values()) clearTimeout(t);
      saveState(statePath, state);
      console.log(chalk.dim("\n✓ watcher stopped, state saved"));
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
