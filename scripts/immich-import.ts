// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — import a local Immich library directory into a Fonto workspace by
// replaying the app's own ingest path (createAssetRow), then writing the bytes
// to BOTH storage backends (R2 + local mirror) synchronously.
//
// Modeled on scripts/import-from-s3.ts: same arg()/flag() parsers, sliding-
// window worker() pool, JSONL manifest + --resume shape.
//
// We write the local mirror inline (rather than letting the async storage-sync
// worker do it) so the P2 delete-gate's dual stat() is deterministic right
// after the run.
//
// Usage:
//   tsx scripts/immich-import.ts \
//     --source-root=/library/admin \
//     --owner-user=<uuid> \
//     --workspace=<uuid> \
//     [--batch=N] [--concurrency=4] [--manifest=/manifests/immich-<tag>.jsonl] \
//     [--dry-run] [--resume]

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import { detectMime } from "@/lib/mime";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";
import { extractExif, dateFromFilename } from "@/lib/exif";

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

// Retry a transient operation with exponential backoff. The R2 endpoint
// occasionally returns DNS `EAI_AGAIN` / socket resets under load — those are
// retryable and should NOT quarantine an otherwise-good file. Throws the last
// error if every attempt fails.
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 500
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * 2 ** i;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[immich-import] ${label} attempt ${i + 1}/${attempts} failed (${msg}); retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

type Outcome =
  | "inserted"
  | "deduplicated"
  | "skipped"
  | "error"
  | "would-insert"
  | "would-dedup";

type DateSource = "exif" | "filename" | "folder" | "none";

interface ManifestLine {
  path: string;
  sha256: string;
  mime: string;
  sizeBytes: number;
  resolvedDate: string | null;
  dateSource: DateSource;
  directoryPath: string | null;
  outcome: Outcome;
  assetId?: string;
  key?: string;
  error?: string;
}

// Recursive walk; skip dotfiles/dotdirs (e.g. `.immich` markers).
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
      // Skip Immich XMP sidecars (e.g. `PXL_123.jpg.xmp`) — XML metadata, not media.
      else if (e.isFile() && path.extname(e.name).toLowerCase() !== ".xmp") out.push(full);
    }
  }
  return out;
}

const YEAR_MIN = 1990;
const YEAR_MAX = new Date().getFullYear() + 1;

function yearOk(d: Date): boolean {
  const y = d.getUTCFullYear();
  return y >= YEAR_MIN && y <= YEAR_MAX;
}

// First YYYY-MM-DD, else YYYY-MM, else a bare 4-digit YYYY segment found in the
// path. Built at noon UTC to dodge timezone date-boundary drift.
function dateFromPath(relPath: string): Date | null {
  let m = relPath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  m = relPath.match(/(\d{4})-(\d{2})(?!\d)/);
  if (m) return new Date(`${m[1]}-${m[2]}-01T12:00:00Z`);
  m = relPath.match(/(?<!\d)(\d{4})(?!\d)/);
  if (m) {
    const y = Number(m[1]);
    if (y >= YEAR_MIN && y <= YEAR_MAX) return new Date(`${m[1]}-01-01T12:00:00Z`);
  }
  return null;
}

async function resolveDate(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  relPath: string
): Promise<{ date: Date | null; source: DateSource }> {
  const exif = (await extractExif(buffer, mimeType)).capturedAt;
  if (exif && yearOk(exif)) return { date: exif, source: "exif" };
  const fromName = dateFromFilename(filename);
  if (fromName && yearOk(fromName)) return { date: fromName, source: "filename" };
  const fromPath = dateFromPath(relPath);
  if (fromPath && yearOk(fromPath)) return { date: fromPath, source: "folder" };
  return { date: null, source: "none" };
}

function deriveDirectoryPath(root: string, file: string): string | null {
  const relDir = path.relative(root, path.dirname(file));
  const posix = relDir.split(path.sep).join("/");
  if (!posix || posix === ".") return null;
  return `/${posix.replace(/^\/+/, "")}`;
}

function readDoneSet(manifestPath: string): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(manifestPath)) return done;
  const lines = fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ManifestLine;
      if (entry.outcome === "inserted" || entry.outcome === "deduplicated") {
        done.add(entry.path);
      }
    } catch {
      // skip malformed
    }
  }
  return done;
}

async function main(): Promise<void> {
  const sourceRoot = arg("source-root");
  const ownerUser = arg("owner-user");
  const workspaceId = arg("workspace");
  const batchRaw = arg("batch");
  const batch = batchRaw ? Number.parseInt(batchRaw, 10) : Number.POSITIVE_INFINITY;
  const concurrencyRaw = arg("concurrency");
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : 4;
  const dryRun = flag("dry-run");
  const resume = flag("resume");

  if (!sourceRoot) throw new Error("--source-root=<dir> required");
  if (!ownerUser) throw new Error("--owner-user=<uuid> required");
  if (!workspaceId) throw new Error("--workspace=<uuid> required");

  const tag = sourceRoot.replace(/[^A-Za-z0-9_-]/g, "_");
  const manifestPath = arg("manifest") || `/manifests/immich-${tag}.jsonl`;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

  const root = path.resolve(sourceRoot);
  let files = walk(root);

  const done = resume ? readDoneSet(manifestPath) : new Set<string>();
  if (done.size) files = files.filter((f) => !done.has(f));

  const manifestStream = fs.createWriteStream(manifestPath, { flags: "a" });
  function record(line: ManifestLine): void {
    manifestStream.write(JSON.stringify(line) + "\n");
  }

  const runId = randomUUID().slice(0, 8);
  console.log(
    `[immich-import] runId=${runId} root=${root} workspace=${workspaceId} ` +
      `files=${files.length} concurrency=${concurrency} dryRun=${dryRun} ` +
      `resume=${resume} (skipped ${done.size} done)`
  );

  const counts: Record<Outcome, number> = {
    inserted: 0,
    deduplicated: 0,
    skipped: 0,
    error: 0,
    "would-insert": 0,
    "would-dedup": 0,
  };
  const quarantine: string[] = [];
  let processed = 0;

  const queue = [...files];

  async function processOne(file: string): Promise<void> {
    const relPath = path.relative(root, file);
    const filename = path.basename(file);
    const directoryPath = deriveDirectoryPath(root, file);

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      counts.error++;
      quarantine.push(file);
      record({
        path: file,
        sha256: "",
        mime: "",
        sizeBytes: 0,
        resolvedDate: null,
        dateSource: "none",
        directoryPath,
        outcome: "error",
        error: msg,
      });
      return;
    }

    if (buffer.length === 0) {
      counts.skipped++;
      record({
        path: file,
        sha256: "",
        mime: "",
        sizeBytes: 0,
        resolvedDate: null,
        dateSource: "none",
        directoryPath,
        outcome: "skipped",
        error: "0-byte file",
      });
      return;
    }

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const { mimeType } = await detectMime(buffer, "", filename);
    const { date: resolved, source: dateSource } = await resolveDate(
      buffer,
      mimeType,
      filename,
      relPath
    );
    const resolvedIso = resolved ? resolved.toISOString() : null;

    const base = {
      path: file,
      sha256,
      mime: mimeType,
      sizeBytes: buffer.length,
      resolvedDate: resolvedIso,
      dateSource,
      directoryPath,
    };

    if (dryRun) {
      const [existing] = await db
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(
          and(
            eq(schema.assets.workspaceId, workspaceId!),
            eq(schema.assets.sha256, sha256),
            eq(schema.assets.lifecycleState, "active")
          )
        )
        .limit(1);
      const outcome: Outcome = existing ? "would-dedup" : "would-insert";
      counts[outcome]++;
      record({ ...base, outcome });
      return;
    }

    try {
      const result = await createAssetRow({
        workspaceId: workspaceId!,
        userId: ownerUser!,
        filename,
        mimeType,
        sizeBytes: buffer.length,
        sha256,
        buffer,
        source: "immich",
        directoryPath,
        ...(resolved ? { metadataOverride: { capturedAt: resolved } } : {}),
      });

      if (result.deduplicated) {
        counts.deduplicated++;
        record({ ...base, outcome: "deduplicated", assetId: result.asset.id });
        return;
      }

      const assetId = result.asset.id;
      const key = assetStorageKey(workspaceId!, assetId, filename);
      try {
        await db
          .update(schema.assets)
          .set({ syncState: "syncing" })
          .where(eq(schema.assets.id, assetId));
        await withRetry(`r2.put ${key}`, () =>
          r2().put(key, buffer, {
            contentType: mimeType,
            contentLength: buffer.length,
          })
        );
        await withRetry(`localFs.put ${key}`, () =>
          localFs().put(key, buffer, {
            contentType: mimeType,
            contentLength: buffer.length,
          })
        );
        await db
          .update(schema.assets)
          .set({ syncState: "synced" })
          .where(eq(schema.assets.id, assetId));
        counts.inserted++;
        record({ ...base, outcome: "inserted", assetId, key });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db
          .update(schema.assets)
          .set({ syncState: "error" })
          .where(eq(schema.assets.id, assetId))
          .catch(() => {});
        counts.error++;
        quarantine.push(file);
        record({ ...base, outcome: "error", assetId, key, error: msg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      counts.error++;
      quarantine.push(file);
      record({ ...base, outcome: "error", error: msg });
    }
  }

  async function worker(): Promise<void> {
    while (queue.length > 0 && processed < batch) {
      const file = queue.shift();
      if (!file) continue;
      processed++;
      await processOne(file);
      if (processed % 25 === 0) {
        console.log(
          `[immich-import] processed=${processed} ins=${counts.inserted} ` +
            `dup=${counts.deduplicated} skip=${counts.skipped} err=${counts.error} ` +
            `wIns=${counts["would-insert"]} wDup=${counts["would-dedup"]}`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  await new Promise<void>((resolve) => {
    manifestStream.end(() => resolve());
  });
  console.log(
    `[immich-import] done. processed=${processed} ` +
      `inserted=${counts.inserted} deduplicated=${counts.deduplicated} ` +
      `skipped=${counts.skipped} error=${counts.error} ` +
      `would-insert=${counts["would-insert"]} would-dedup=${counts["would-dedup"]} ` +
      `quarantined=${quarantine.length}`
  );
  console.log(`[immich-import] manifest=${manifestPath}`);
  if (quarantine.length) {
    console.log(`[immich-import] quarantined files:\n${quarantine.join("\n")}`);
  }
}

// createAssetRow opens pg + redis pools that keep the event loop alive, so the
// process won't exit on its own — force it after the manifest stream flushes.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
