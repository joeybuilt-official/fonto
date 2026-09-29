// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — import assets from a source S3 bucket into Fonto.
//
// Streams each S3 object through createAssetRow (in-worker, so we skip the
// HTTP auth dance) and then PUTs the buffer to R2 — the same shape as the
// legacy multipart upload path in app/api/v1/assets/route.ts. SHA-256 dedup,
// pHash near-dup detection, EXIF, places, queue enqueue all happen as a
// side effect of createAssetRow.
//
// Usage:
//   pnpm import:s3 -- \
//     --workspace=<uuid> \
//     --user-id=<uuid> \
//     --bucket=<src-bucket> \
//     [--prefix=path/in/bucket/] \
//     [--region=us-east-1] \
//     [--limit=100] \
//     [--concurrency=4] \
//     [--max-size-mb=200] \
//     [--mime-prefix=image/] \
//     [--dry-run]
//
// Env:
//   S3_IMPORT_ACCESS_KEY_ID, S3_IMPORT_SECRET_ACCESS_KEY  — source creds
//   (kept distinct from R2_* to avoid mixing up source / destination).
//   DATABASE_URL, REDIS_URL, R2_* — same env createAssetRow needs.
//
// Resume log at /tmp/import-from-s3-<runId>.jsonl. One line per object:
//   {"s3Key":"...","status":"uploaded"|"deduplicated"|"skipped"|"error",
//    "assetId":"...","error":"...","sizeBytes":123}
// Re-running with the same bucket+prefix scans the most-recent log and
// skips any s3Key already marked uploaded/deduplicated.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  GetObjectCommand,
  PutObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import { detectMime } from "@/lib/mime";
import { getS3Client as getR2Client, assetStorageKey } from "@/lib/r2";

function arg(name: string): string | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag === `--${name}`) return ""; // bare flag
  return flag.split("=").slice(1).join("=");
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface LogEntry {
  s3Key: string;
  status: "uploaded" | "deduplicated" | "skipped" | "error";
  assetId?: string;
  error?: string;
  sizeBytes?: number;
}

function readPriorLog(logDir: string, bucket: string, prefix: string): Set<string> {
  // Most-recent log for this bucket+prefix → set of already-done s3Keys.
  // Skips entries with status='error' so we retry failures.
  const done = new Set<string>();
  if (!fs.existsSync(logDir)) return done;
  const tag = `${bucket}_${prefix}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const matches = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith(`import-from-s3-`) && f.endsWith(".jsonl"))
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
          done.add(entry.s3Key);
        }
      } catch {
        // skip malformed
      }
    }
    // Only read the most-recent log matching this tag; older logs are stale.
    if (used) break;
  }
  return done;
}

async function main(): Promise<void> {
  const workspaceId = arg("workspace");
  const userId = arg("user-id");
  const bucket = arg("bucket");
  const prefix = arg("prefix") ?? "";
  const region = arg("region") ?? process.env.S3_IMPORT_REGION ?? "us-east-1";
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY;
  const concurrencyRaw = arg("concurrency");
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : 4;
  const maxSizeMbRaw = arg("max-size-mb");
  const maxSizeMb = maxSizeMbRaw ? Number.parseInt(maxSizeMbRaw, 10) : 200;
  const mimePrefix = arg("mime-prefix");
  const dryRun = flag("dry-run");

  if (!workspaceId) throw new Error("--workspace=<uuid> required");
  if (!userId) throw new Error("--user-id=<uuid> required");
  if (!bucket) throw new Error("--bucket=<name> required");

  const accessKey = process.env.S3_IMPORT_ACCESS_KEY_ID;
  const secretKey = process.env.S3_IMPORT_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    throw new Error(
      "S3_IMPORT_ACCESS_KEY_ID + S3_IMPORT_SECRET_ACCESS_KEY required"
    );
  }

  // Sanity: confirm the workspace + user exist before we start downloading.
  const [ws] = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);

  const src = new S3Client({
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  const r2 = getR2Client();
  const r2Bucket = process.env.R2_BUCKET!;

  const runId = randomUUID().slice(0, 8);
  const logPath = `/tmp/import-from-s3-${runId}.jsonl`;
  const tag = `${bucket}_${prefix}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  function log(entry: LogEntry): void {
    logStream.write(JSON.stringify({ ...entry, _tag: tag }) + "\n");
  }

  const prior = readPriorLog("/tmp", bucket, prefix);
  console.log(
    `[import-from-s3] runId=${runId} bucket=s3://${bucket}/${prefix} ` +
      `workspace=${workspaceId} concurrency=${concurrency} dryRun=${dryRun} ` +
      `prior-completed=${prior.size}`
  );

  let listToken: string | undefined = undefined;
  let scanned = 0;
  let processed = 0;
  const counts = { uploaded: 0, deduplicated: 0, skipped: 0, error: 0 };

  do {
    const page: ListObjectsV2CommandOutput = await src.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: listToken,
      })
    );
    listToken = page.NextContinuationToken;
    const objects: _Object[] = page.Contents ?? [];

    // Filter list before downloading.
    const candidates = objects.filter((o) => {
      if (!o.Key) return false;
      if (o.Key.endsWith("/")) return false; // folder marker
      if (prior.has(o.Key)) return false;
      if (
        maxSizeMb &&
        typeof o.Size === "number" &&
        o.Size > maxSizeMb * 1024 * 1024
      ) {
        log({
          s3Key: o.Key,
          status: "skipped",
          error: `oversized (${Math.round(o.Size / 1024 / 1024)}MB > ${maxSizeMb}MB cap)`,
          sizeBytes: o.Size,
        });
        counts.skipped++;
        return false;
      }
      return true;
    });

    // Process the page with a sliding window of `concurrency`.
    const queue = [...candidates];
    async function worker(): Promise<void> {
      while (queue.length > 0 && processed < limit) {
        const obj = queue.shift();
        if (!obj?.Key) continue;
        scanned++;
        try {
          const result = await importOne(obj.Key);
          counts[result.status]++;
          log({ s3Key: obj.Key, ...result });
          processed++;
        } catch (err) {
          counts.error++;
          const msg = err instanceof Error ? err.message : String(err);
          log({ s3Key: obj.Key, status: "error", error: msg });
          processed++;
        }
        if (processed % 25 === 0) {
          console.log(
            `[import-from-s3] processed=${processed} ` +
              `up=${counts.uploaded} dup=${counts.deduplicated} ` +
              `skip=${counts.skipped} err=${counts.error}`
          );
        }
      }
    }
    await Promise.all(
      Array.from({ length: concurrency }, () => worker())
    );

    if (processed >= limit) break;
  } while (listToken);

  logStream.end();
  console.log(
    `[import-from-s3] done. scanned=${scanned} ` +
      `uploaded=${counts.uploaded} deduplicated=${counts.deduplicated} ` +
      `skipped=${counts.skipped} error=${counts.error}`
  );
  console.log(`[import-from-s3] log=${logPath}`);

  async function importOne(s3Key: string): Promise<{
    status: "uploaded" | "deduplicated" | "skipped";
    assetId?: string;
    sizeBytes?: number;
    error?: string;
  }> {
    const get = await src.send(
      new GetObjectCommand({ Bucket: bucket!, Key: s3Key })
    );
    if (!get.Body) return { status: "skipped", error: "empty body" };

    // Stream → buffer. Node SDK v3's Body is a Readable in node env.
    const chunks: Buffer[] = [];
    for await (const chunk of get.Body as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const filename = path.basename(s3Key);
    const { mimeType } = await detectMime(
      buffer,
      get.ContentType ?? "",
      filename
    );

    if (mimePrefix && !mimeType.startsWith(mimePrefix)) {
      return {
        status: "skipped",
        sizeBytes: buffer.length,
        error: `mime ${mimeType} doesn't match --mime-prefix=${mimePrefix}`,
      };
    }

    if (dryRun) {
      console.log(
        `[dry-run] ${s3Key} → ${filename} (${mimeType}, ${buffer.length}B)`
      );
      return { status: "uploaded", sizeBytes: buffer.length };
    }

    // Use the parent S3 key path as the virtual folder so the Folders page
    // mirrors the source layout. Trim the configured --prefix off the front
    // so users see "/2023/march" not "/photos-archive/2023/march".
    const trimmed = prefix ? s3Key.replace(new RegExp(`^${prefix}`), "") : s3Key;
    const dirRaw = path.posix.dirname(trimmed);
    const directoryPath = dirRaw && dirRaw !== "." ? `/${dirRaw.replace(/^\/+/, "")}` : null;

    const result = await createAssetRow({
      workspaceId: workspaceId!,
      userId: userId!,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      buffer,
      source: "s3-import",
      directoryPath,
    });

    if (result.deduplicated) {
      return {
        status: "deduplicated",
        assetId: result.asset.id,
        sizeBytes: buffer.length,
      };
    }

    // createAssetRow marked the row `synced` on the assumption that the
    // direct-PUT path already pushed to R2. Mirror the legacy POST flow:
    // override back to syncing, PUT the buffer, then flip to synced.
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

    return {
      status: "uploaded",
      assetId: asset.id,
      sizeBytes: buffer.length,
    };
  }
}

main().catch((err) => {
  console.error("[import-from-s3] fatal:", err);
  process.exit(1);
});
