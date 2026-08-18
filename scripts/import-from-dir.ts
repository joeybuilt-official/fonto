// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — import assets from a local directory tree into Fonto.
//
// Sibling of import-from-s3.ts: instead of listing an S3 bucket it walks a
// local directory, streams each file through createAssetRow (in-worker, so we
// skip the HTTP auth dance) and then PUTs the buffer to R2 — same shape as the
// legacy multipart upload path. SHA-256 dedup, pHash near-dup detection, EXIF,
// places, queue enqueue all happen as a side effect of createAssetRow.
//
// Built to drain a Nextcloud data directory; works for any local tree.
//
// Usage:
//   tsx scripts/import-from-dir.ts \
//     --dir=/import \
//     --workspace=<uuid> \
//     --user-id=<uuid> \
//     [--ext=jpg,jpeg,png,heic,...]      (default: media + pdf allowlist)
//     [--exclude-dirs=node_modules,.git]  (default below; pruned during walk)
//     [--limit=100] \
//     [--concurrency=4] \
//     [--max-size-mb=1024] \
//     [--mime-prefix=image/] \
//     [--dry-run]
//
// Env: DATABASE_URL, REDIS_URL, R2_*, PLEXO_* — same env createAssetRow needs.
//
// Resume log at /tmp/import-from-dir-<runId>.jsonl. One line per file:
//   {"path":"<rel>","status":"uploaded"|"deduplicated"|"skipped"|"error",
//    "assetId":"...","error":"...","sizeBytes":123}
// Re-running with the same --dir scans the most-recent log and skips any
// relative path already marked uploaded/deduplicated.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import { detectMime } from "@/lib/mime";
import { getS3Client as getR2Client, assetStorageKey } from "@/lib/r2";

const DEFAULT_EXTS = [
  // images
  "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tif", "tiff",
  // raw
  "cr2", "cr3", "dng", "nef", "arw", "raf", "orf", "rw2", "raw",
  // video
  "mp4", "mov", "m4v", "avi", "mkv", "webm", "3gp", "mpg", "mpeg", "wmv",
  // documents
  "pdf",
];

// Directories whose subtrees are code/build artifacts, not user media.
// Pruned during traversal so a general-purpose file store doesn't flood the
// library with node_modules icons, pdf.js UI buttons, etc.
const DEFAULT_EXCLUDE_DIRS = [
  "node_modules", ".git", "dist", "build", ".next", "vendor",
  "site-packages", ".venv", "venv", "__pycache__", ".cache",
];

function arg(name: string): string | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag === `--${name}`) return "";
  return flag.split("=").slice(1).join("=");
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface LogEntry {
  path: string;
  status: "uploaded" | "deduplicated" | "skipped" | "error";
  assetId?: string;
  error?: string;
  sizeBytes?: number;
}

function readPriorLog(logDir: string, tag: string): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(logDir)) return done;
  const matches = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("import-from-dir-") && f.endsWith(".jsonl"))
    .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of matches) {
    const lines = fs
      .readFileSync(path.join(logDir, f), "utf8")
      .split("\n")
      .filter(Boolean);
    let used = false;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry & { _tag?: string };
        if (entry._tag && entry._tag === tag) used = true;
        if (entry.status === "uploaded" || entry.status === "deduplicated") {
          done.add(entry.path);
        }
      } catch {
        // skip malformed
      }
    }
    if (used) break;
  }
  return done;
}

// Recursive walk → relative paths of files whose extension is in `exts`,
// pruning any directory in `excludeDirs`. Filtering during traversal avoids
// stat-ing the (often huge) tail of non-media files in a general file store.
async function walk(
  root: string,
  exts: Set<string>,
  excludeDirs: Set<string>
): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) continue;
        await recurse(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (exts.has(ext)) out.push(path.relative(root, path.join(dir, e.name)));
      }
    }
  }
  await recurse(root);
  return out;
}

async function main(): Promise<void> {
  const dir = arg("dir");
  const workspaceId = arg("workspace");
  const userId = arg("user-id");
  const extRaw = arg("ext");
  const excludeRaw = arg("exclude-dirs");
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY;
  const concurrencyRaw = arg("concurrency");
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : 4;
  const maxSizeMbRaw = arg("max-size-mb");
  const maxSizeMb = maxSizeMbRaw ? Number.parseInt(maxSizeMbRaw, 10) : 1024;
  const mimePrefix = arg("mime-prefix");
  const dryRun = flag("dry-run");

  if (!dir) throw new Error("--dir=<path> required");
  if (!workspaceId) throw new Error("--workspace=<uuid> required");
  if (!userId) throw new Error("--user-id=<uuid> required");

  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`--dir ${root} is not a directory`);
  }

  const exts = new Set(
    (extRaw ? extRaw.split(",") : DEFAULT_EXTS)
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean)
  );
  const excludeDirs = new Set(
    (excludeRaw ? excludeRaw.split(",") : DEFAULT_EXCLUDE_DIRS)
      .map((d) => d.trim())
      .filter(Boolean)
  );

  const [ws] = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);

  const r2 = getR2Client();
  const r2Bucket = process.env.R2_BUCKET!;

  const runId = randomUUID().slice(0, 8);
  const logPath = `/tmp/import-from-dir-${runId}.jsonl`;
  const tag = root.replace(/[^A-Za-z0-9_-]/g, "_");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  function log(entry: LogEntry): void {
    logStream.write(JSON.stringify({ ...entry, _tag: tag }) + "\n");
  }

  const prior = readPriorLog("/tmp", tag);
  console.log(
    `[import-from-dir] runId=${runId} dir=${root} ` +
      `workspace=${workspaceId} concurrency=${concurrency} dryRun=${dryRun} ` +
      `prior-completed=${prior.size}`
  );

  const allFiles = await walk(root, exts, excludeDirs);
  const counts = { uploaded: 0, deduplicated: 0, skipped: 0, error: 0 };

  const candidates = allFiles.filter((rel) => {
    if (prior.has(rel)) return false;
    const size = fs.statSync(path.join(root, rel)).size;
    if (maxSizeMb && size > maxSizeMb * 1024 * 1024) {
      counts.skipped++;
      log({
        path: rel,
        status: "skipped",
        sizeBytes: size,
        error: `oversized (${Math.round(size / 1024 / 1024)}MB > ${maxSizeMb}MB cap)`,
      });
      return false;
    }
    return true;
  });

  console.log(
    `[import-from-dir] matched=${allFiles.length} toProcess=${candidates.length} ` +
      `(oversized-skipped=${counts.skipped})`
  );

  const queue = [...candidates];
  let processed = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0 && processed < limit) {
      const rel = queue.shift();
      if (!rel) continue;
      try {
        const result = await importOne(rel);
        counts[result.status]++;
        log({ path: rel, ...result });
      } catch (err) {
        counts.error++;
        const msg = err instanceof Error ? err.message : String(err);
        log({ path: rel, status: "error", error: msg });
      }
      processed++;
      if (processed % 25 === 0) {
        console.log(
          `[import-from-dir] processed=${processed}/${candidates.length} ` +
            `up=${counts.uploaded} dup=${counts.deduplicated} ` +
            `skip=${counts.skipped} err=${counts.error}`
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  logStream.end();
  console.log(
    `[import-from-dir] done. matched=${allFiles.length} ` +
      `uploaded=${counts.uploaded} deduplicated=${counts.deduplicated} ` +
      `skipped=${counts.skipped} error=${counts.error}`
  );
  console.log(`[import-from-dir] log=${logPath}`);

  async function importOne(rel: string): Promise<{
    status: "uploaded" | "deduplicated" | "skipped";
    assetId?: string;
    sizeBytes?: number;
    error?: string;
  }> {
    const abs = path.join(root, rel);
    const buffer = await fsp.readFile(abs);
    const filename = path.basename(rel);
    const { mimeType } = await detectMime(buffer, "", filename);

    if (mimePrefix && !mimeType.startsWith(mimePrefix)) {
      return {
        status: "skipped",
        sizeBytes: buffer.length,
        error: `mime ${mimeType} doesn't match --mime-prefix=${mimePrefix}`,
      };
    }

    if (dryRun) {
      return { status: "uploaded", sizeBytes: buffer.length };
    }

    // Mirror the source folder layout as a Fonto virtual folder.
    const dirRaw = path.posix.dirname(rel.split(path.sep).join("/"));
    const directoryPath =
      dirRaw && dirRaw !== "." ? `/${dirRaw.replace(/^\/+/, "")}` : null;

    const result = await createAssetRow({
      workspaceId: workspaceId!,
      userId: userId!,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      buffer,
      source: "dir-import",
      directoryPath,
    });

    if (result.deduplicated) {
      return {
        status: "deduplicated",
        assetId: result.asset.id,
        sizeBytes: buffer.length,
      };
    }

    const asset = result.asset;
    await db
      .update(schema.assets)
      .set({ syncState: "syncing" })
      .where(eq(schema.assets.id, asset.id));

    const r2Key = assetStorageKey(workspaceId!, asset.id, filename);
    try {
      await r2.send(
        new PutObjectCommand({
          Bucket: r2Bucket,
          Key: r2Key,
          Body: buffer,
          ContentType: mimeType,
          ContentLength: buffer.length,
        })
      );
      await db
        .update(schema.assets)
        .set({ syncState: "synced" })
        .where(eq(schema.assets.id, asset.id));
    } catch (err) {
      await db
        .update(schema.assets)
        .set({ syncState: "error" })
        .where(eq(schema.assets.id, asset.id));
      throw err;
    }

    return { status: "uploaded", assetId: asset.id, sizeBytes: buffer.length };
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[import-from-dir] fatal:", err);
  process.exit(1);
});
