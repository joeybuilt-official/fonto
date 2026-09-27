// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — import LARGE media files (>2 GiB) that the buffer-based
// scripts/immich-import.ts cannot handle (it does fs.readFileSync → Node Buffer
// caps at ~2 GiB). Streams instead of buffering:
//   - SHA-256 via a read stream (no whole-file buffer)
//   - R2 via manual multipart (CreateMultipartUpload/UploadPart/Complete;
//     @aws-sdk/lib-storage is not installed, only client-s3)
//   - local mirror via a read stream (the local backend accepts a Readable)
// Then inserts the asset row directly, replicating createAssetRow's .values
// block (all image-only fields — phash/colors/exif/CLIP — are null for video).
//
// Usage:
//   tsx scripts/immich-import-large.mts \
//     --source-root=/secondlib/photos/library \
//     --owner-user=<uuid> --workspace=<uuid> \
//     --files=/secondlib/.../a.MOV,/secondlib/.../b.MOV \
//     --manifest=<LOCAL_STORAGE_ROOT>/_immich-manifests/import.jsonl \
//     [--part-mib=128] [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { nextSeq } from "@/lib/db/seq";
import { deriveScope } from "@/lib/scope";
import { detectMime } from "@/lib/mime";
import { assetStorageKey, getS3Client } from "@/lib/r2";
import { localFs } from "@/lib/storage";
import { dateFromFilename } from "@/lib/exif";
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";

function arg(name: string): string | null {
  const f = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  if (f === `--${name}`) return "";
  return f.split("=").slice(1).join("=");
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4, base = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) {
        const delay = base * 2 ** i;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[large] ${label} attempt ${i + 1}/${attempts} failed (${msg}); retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw last;
}

const YEAR_MIN = 1990;
const YEAR_MAX = new Date().getFullYear() + 1;
function yearOk(d: Date): boolean {
  const y = d.getUTCFullYear();
  return y >= YEAR_MIN && y <= YEAR_MAX;
}
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
function deriveDirectoryPath(root: string, file: string): string | null {
  const relDir = path.relative(root, path.dirname(file));
  const posix = relDir.split(path.sep).join("/");
  if (!posix || posix === ".") return null;
  return `/${posix.replace(/^\/+/, "")}`;
}

function streamSha(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => res(h.digest("hex")));
    s.on("error", rej);
  });
}
function readRange(file: string, start: number, end: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    const s = fs.createReadStream(file, { start, end });
    s.on("data", (d) => chunks.push(d as Buffer));
    s.on("end", () => res(Buffer.concat(chunks)));
    s.on("error", rej);
  });
}
function readHead(file: string, n = 65535): Promise<Buffer> {
  return readRange(file, 0, n);
}

async function multipartPutR2(key: string, file: string, size: number, contentType: string, partSize: number): Promise<void> {
  const s3 = getS3Client();
  const Bucket = process.env.R2_BUCKET;
  if (!Bucket) throw new Error("R2_BUCKET env required");
  const create = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
  const UploadId = create.UploadId!;
  const parts: { ETag: string; PartNumber: number }[] = [];
  try {
    let partNumber = 1;
    for (let start = 0; start < size; start += partSize) {
      const end = Math.min(start + partSize, size) - 1;
      const body = await readRange(file, start, end);
      const r = await withRetry(`uploadPart#${partNumber} ${key}`, () =>
        s3.send(new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: partNumber, Body: body, ContentLength: body.length }))
      );
      if (!r.ETag) throw new Error(`part ${partNumber} returned no ETag`);
      parts.push({ ETag: r.ETag, PartNumber: partNumber });
      console.log(`[large]   ${path.basename(file)} part ${partNumber} (${(end + 1) / 1e9} GB) ok`);
      partNumber++;
    }
    await withRetry(`complete ${key}`, () =>
      s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }))
    );
  } catch (err) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId })).catch(() => {});
    throw err;
  }
}

async function main(): Promise<void> {
  const sourceRoot = arg("source-root");
  const ownerUser = arg("owner-user");
  const workspaceId = arg("workspace");
  const filesRaw = arg("files");
  const manifestPath = arg("manifest");
  const partSize = (Number.parseInt(arg("part-mib") || "128", 10)) * 1024 * 1024;
  const dryRun = flag("dry-run");
  if (!sourceRoot) throw new Error("--source-root required");
  if (!ownerUser) throw new Error("--owner-user required");
  if (!workspaceId) throw new Error("--workspace required");
  if (!filesRaw) throw new Error("--files=<comma-separated paths> required");
  if (!manifestPath) throw new Error("--manifest required");
  const files = filesRaw.split(",").map((s) => s.trim()).filter(Boolean);

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifestStream = fs.createWriteStream(manifestPath, { flags: "a" });
  const record = (line: Record<string, unknown>) => manifestStream.write(JSON.stringify(line) + "\n");

  let inserted = 0,
    deduplicated = 0,
    error = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const relPath = path.relative(sourceRoot, file);
    const directoryPath = deriveDirectoryPath(sourceRoot, file);
    try {
      const st = fs.statSync(file);
      const size = st.size;
      console.log(`[large] ${filename} size=${(size / 1e9).toFixed(2)} GB — hashing…`);
      const sha256 = await streamSha(file);
      const head = await readHead(file);
      const { mimeType } = await detectMime(head, "", filename);

      // Date: filename → folder path (no EXIF — video moov atom not in head buffer).
      const fromName = dateFromFilename(filename);
      const fromPath = dateFromPath(relPath);
      const capturedAt: Date | null =
        fromName && yearOk(fromName) ? fromName : fromPath && yearOk(fromPath) ? fromPath : null;

      const [dup] = await db
        .select()
        .from(schema.assets)
        .where(
          and(
            eq(schema.assets.workspaceId, workspaceId),
            eq(schema.assets.sha256, sha256),
            eq(schema.assets.lifecycleState, "active")
          )
        )
        .limit(1);
      if (dup) {
        deduplicated++;
        record({ path: file, sha256, mime: mimeType, sizeBytes: size, directoryPath, outcome: "deduplicated", assetId: dup.id });
        console.log(`[large] ${filename} DEDUP (sha already present)`);
        continue;
      }

      if (dryRun) {
        record({ path: file, sha256, mime: mimeType, sizeBytes: size, directoryPath, resolvedDate: capturedAt?.toISOString() ?? null, outcome: "would-insert" });
        console.log(`[large] ${filename} would-insert sha=${sha256} mime=${mimeType} date=${capturedAt?.toISOString() ?? "null"} dir=${directoryPath}`);
        continue;
      }

      const resolvedScope = deriveScope({ directoryPath });
      const assetSeq = await nextSeq(workspaceId, "asset");
      const [asset] = await db
        .insert(schema.assets)
        .values({
          workspaceId,
          filename,
          mimeType,
          sizeBytes: size,
          sha256,
          seq: assetSeq,
          syncState: "syncing",
          processingState: "captured",
          lifecycleState: "active",
          scope: resolvedScope,
          source: "immich",
          extractedText: null,
          capturedAt,
          phash: null,
          colors: null,
          exif: null,
          latitude: null,
          longitude: null,
          placeName: null,
          cameraMake: null,
          cameraModel: null,
          lensModel: null,
          focalLength: null,
          fNumber: null,
          iso: null,
          exposureTime: null,
          orientation: null,
          widthPx: null,
          heightPx: null,
          ocrState: "skipped",
          directoryPath,
        })
        .returning();

      const assetId = asset.id;
      const key = assetStorageKey(workspaceId, assetId, filename);
      try {
        await multipartPutR2(key, file, size, mimeType, partSize);
        await withRetry(`localFs.put ${key}`, () =>
          localFs().put(key, fs.createReadStream(file), { contentType: mimeType, contentLength: size })
        );
        await db.update(schema.assets).set({ syncState: "synced" }).where(eq(schema.assets.id, assetId));
        inserted++;
        record({ path: file, sha256, mime: mimeType, sizeBytes: size, directoryPath, resolvedDate: capturedAt?.toISOString() ?? null, outcome: "inserted", assetId, key });
        console.log(`[large] ${filename} INSERTED + synced (asset=${assetId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.update(schema.assets).set({ syncState: "error" }).where(eq(schema.assets.id, assetId)).catch(() => {});
        error++;
        record({ path: file, sha256, mime: mimeType, sizeBytes: size, directoryPath, outcome: "error", assetId, key, error: msg });
        console.error(`[large] ${filename} UPLOAD ERROR: ${msg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error++;
      record({ path: file, sha256: "", mime: "", sizeBytes: 0, directoryPath, outcome: "error", error: msg });
      console.error(`[large] ${filename} ERROR: ${msg}`);
    }
  }

  await new Promise<void>((resolve) => manifestStream.end(() => resolve()));
  console.log(`[large] done. inserted=${inserted} deduplicated=${deduplicated} error=${error} manifest=${manifestPath}`);
  process.exit(error > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[large] fatal:", err);
  process.exit(1);
});
