#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Backfill perceptual metadata (pHash + colors) and/or OCR text for assets
// uploaded before these features shipped.
//
// Usage:
//   node scripts/backfill-perceptual.mjs --phash      # just pHash + colors
//   node scripts/backfill-perceptual.mjs --ocr        # just OCR
//   node scripts/backfill-perceptual.mjs --all        # both
//   node scripts/backfill-perceptual.mjs --batch=50 --all
//
// Reads DATABASE_URL, R2_*, PLEXO_URL, PLEXO_SERVICE_KEY from env.
// Idempotent: skips rows that already have the relevant column populated.

import postgres from "postgres";
import sharp from "sharp";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/* ─── pHash + palette (mirrors lib/perceptual.ts) ───────────────────── */

const N = 32;
const H = 8;
const PALETTE_RESIZE = 100;
const PALETTE_K = 8;
const KMEANS_ITERS = 16;

const DCT = (() => {
  const m = Array.from({ length: N }, () => new Array(N).fill(0));
  const c0 = Math.sqrt(1 / N);
  const c = Math.sqrt(2 / N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) {
      m[k][n] = (k === 0 ? c0 : c) * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
    }
  }
  return m;
})();

function dct2d(input) {
  const temp = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      let s = 0;
      const ri = i * N;
      for (let n = 0; n < N; n++) s += DCT[k][n] * input[ri + n];
      temp[ri + k] = s;
    }
  }
  const out = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < N; k++) {
      let s = 0;
      for (let i = 0; i < N; i++) s += DCT[k][i] * temp[i * N + j];
      out[k * N + j] = s;
    }
  }
  return out;
}

async function computePHash(buffer) {
  const { data } = await sharp(buffer).resize(N, N, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  if (data.length !== N * N) throw new Error("phash decode: bad pixel count");
  const px = new Float64Array(N * N);
  for (let i = 0; i < px.length; i++) px[i] = data[i];
  const dct = dct2d(px);
  const block = new Float64Array(H * H);
  for (let i = 0; i < H; i++) for (let j = 0; j < H; j++) block[i * H + j] = dct[i * N + j];
  const sorted = Array.from(block.slice(1)).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  let hash = 0n;
  for (let i = 0; i < H * H; i++) if (block[i] > median) hash |= 1n << BigInt(i);
  return hash;
}

async function extractPalette(buffer) {
  const { data, info } = await sharp(buffer).resize(PALETTE_RESIZE, PALETTE_RESIZE, { fit: "cover" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels < 3) return [];
  const pixels = [];
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    pixels.push([data[o], data[o + 1], data[o + 2]]);
  }
  const k = Math.min(PALETTE_K, pixels.length);
  const stride = Math.max(1, Math.floor(pixels.length / k));
  const centroids = [];
  for (let i = 0; i < k; i++) centroids.push([...pixels[Math.min(i * stride, pixels.length - 1)]]);
  const assignments = new Int32Array(pixels.length);
  for (let it = 0; it < KMEANS_ITERS; it++) {
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];
      let best = 0, bd = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const cc = centroids[c];
        const dr = p[0] - cc[0], dg = p[1] - cc[1], db = p[2] - cc[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      assignments[i] = best;
    }
    const sums = Array.from({ length: centroids.length }, () => [0, 0, 0]);
    const cnt = new Int32Array(centroids.length);
    for (let i = 0; i < pixels.length; i++) {
      const c = assignments[i], p = pixels[i];
      sums[c][0] += p[0]; sums[c][1] += p[1]; sums[c][2] += p[2]; cnt[c]++;
    }
    let drift = 0;
    for (let c = 0; c < centroids.length; c++) {
      if (cnt[c] === 0) continue;
      const nr = sums[c][0] / cnt[c], ng = sums[c][1] / cnt[c], nb = sums[c][2] / cnt[c];
      drift += Math.abs(nr - centroids[c][0]) + Math.abs(ng - centroids[c][1]) + Math.abs(nb - centroids[c][2]);
      centroids[c] = [nr, ng, nb];
    }
    if (drift < 1) break;
  }
  const cnt = new Int32Array(centroids.length);
  for (let i = 0; i < assignments.length; i++) cnt[assignments[i]]++;
  const palette = [];
  for (let c = 0; c < centroids.length; c++) {
    if (cnt[c] === 0) continue;
    const [r, g, b] = centroids[c];
    const hex = "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
    palette.push({ hex, weight: cnt[c] / pixels.length });
  }
  palette.sort((a, b) => b.weight - a.weight);
  return palette;
}

/* ─── R2 + Plexo helpers ─────────────────────────────────────────────── */

function s3() {
  return new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: "auto",
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function fetchObject(bucket, key) {
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function presignFor(bucket, key) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

async function plexoVisionOcr(workspaceId, imageUrl) {
  const url = (process.env.PLEXO_URL || "").replace(/\/$/, "");
  const key = process.env.PLEXO_SERVICE_KEY || "";
  if (!url || !key) return null;
  const res = await fetch(`${url}/api/v1/vision/ocr`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-App-Id": "fonto",
    },
    body: JSON.stringify({ workspaceId, imageUrl }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function plexoEnsureWorkspace(userId, email) {
  const url = (process.env.PLEXO_URL || "").replace(/\/$/, "");
  const key = process.env.PLEXO_SERVICE_KEY || "";
  if (!url || !key) return null;
  const res = await fetch(`${url}/api/v1/auth/workspace/ensure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-App-Id": "fonto",
      "X-User-Id": userId,
    },
    body: JSON.stringify({ userId, name: "Fonto", email }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.workspaceId;
}

/* ─── Driver ────────────────────────────────────────────────────────── */

function arg(name) {
  const flag = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

async function main() {
  const phashMode = !!arg("phash") || !!arg("all");
  const ocrMode = !!arg("ocr") || !!arg("all");
  const batchSize = parseInt(arg("batch") || "50", 10);
  if (!phashMode && !ocrMode) {
    console.error("Usage: --phash | --ocr | --all  [--batch=50]");
    process.exit(2);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = postgres(dbUrl, { prepare: false });
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET not set");

  let stats = { phash: { tried: 0, ok: 0, skip: 0, fail: 0 }, ocr: { tried: 0, ok: 0, skip: 0, fail: 0 } };

  /* pHash + colors backfill */
  if (phashMode) {
    console.log("[backfill] pHash + colors: starting");
    // Single-pass keyset on (created_at, id) DESC so failed rows (R2 fetch
    // error, both pHash and palette returning null) get skipped past via the
    // cursor instead of being re-selected forever on `phash IS NULL`. The
    // `phash IS NULL` predicate still narrows the working set within a pass;
    // the cursor guarantees forward progress across failures. Re-runs start
    // from the top and will retry transient failures.
    let cursorCreatedAt = null;
    let cursorId = null;
    for (;;) {
      const rows = cursorCreatedAt && cursorId
        ? await sql`
            SELECT id, workspace_id, filename, mime_type, created_at::text AS created_at
            FROM fonto.assets
            WHERE lifecycle_state = 'active'
              AND mime_type LIKE 'image/%'
              AND phash IS NULL
              AND (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
            ORDER BY created_at DESC, id DESC
            LIMIT ${batchSize}
          `
        : await sql`
            SELECT id, workspace_id, filename, mime_type, created_at::text AS created_at
            FROM fonto.assets
            WHERE lifecycle_state = 'active'
              AND mime_type LIKE 'image/%'
              AND phash IS NULL
            ORDER BY created_at DESC, id DESC
            LIMIT ${batchSize}
          `;
      if (rows.length === 0) break;
      for (const r of rows) {
        stats.phash.tried++;
        try {
          const key = `fonto/${r.workspace_id}/${r.id}/${r.filename}`;
          const buf = await fetchObject(bucket, key);
          const [phash, colors] = await Promise.all([
            computePHash(buf).catch(() => null),
            extractPalette(buf).catch(() => null),
          ]);
          await sql`
            UPDATE fonto.assets
            SET phash = ${phash != null ? phash.toString() : null}, colors = ${colors ? sql.json(colors) : null}
            WHERE id = ${r.id}
          `;
          if (phash != null) stats.phash.ok++; else stats.phash.skip++;
        } catch (err) {
          console.warn(`[backfill] phash failed for ${r.id}:`, err.message);
          stats.phash.fail++;
        }
      }
      const last = rows[rows.length - 1];
      cursorCreatedAt = last.created_at;
      cursorId = last.id;
      if (rows.length < batchSize) break;
    }
    console.log("[backfill] pHash:", JSON.stringify(stats.phash));
  }

  /* OCR backfill */
  if (ocrMode) {
    console.log("[backfill] OCR: starting");
    // Map fonto workspace -> plexo workspace once per pass.
    const wsCache = new Map();
    while (true) {
      const rows = await sql`
        SELECT a.id, a.workspace_id, a.filename, a.mime_type, w.user_id
        FROM fonto.assets a
        JOIN fonto.workspaces w ON w.id = a.workspace_id
        WHERE a.lifecycle_state = 'active'
          AND a.mime_type LIKE 'image/%'
          AND a.ocr_state = 'pending'
        ORDER BY a.created_at DESC
        LIMIT ${batchSize}
      `;
      if (rows.length === 0) break;
      for (const r of rows) {
        stats.ocr.tried++;
        try {
          let plexoWs = wsCache.get(r.workspace_id);
          if (!plexoWs) {
            plexoWs = await plexoEnsureWorkspace(r.user_id, undefined);
            if (plexoWs) wsCache.set(r.workspace_id, plexoWs);
          }
          if (!plexoWs) {
            await sql`UPDATE fonto.assets SET ocr_state = 'failed' WHERE id = ${r.id}`;
            stats.ocr.fail++;
            continue;
          }
          const key = `fonto/${r.workspace_id}/${r.id}/${r.filename}`;
          const url = await presignFor(bucket, key);
          const result = await plexoVisionOcr(plexoWs, url);
          if (!result) {
            await sql`UPDATE fonto.assets SET ocr_state = 'failed' WHERE id = ${r.id}`;
            stats.ocr.fail++;
            continue;
          }
          await sql`
            UPDATE fonto.assets
            SET ocr_text = ${result.text || ""}, ocr_state = 'ready'
            WHERE id = ${r.id}
          `;
          stats.ocr.ok++;
        } catch (err) {
          console.warn(`[backfill] ocr failed for ${r.id}:`, err.message);
          await sql`UPDATE fonto.assets SET ocr_state = 'failed' WHERE id = ${r.id}`.catch(() => {});
          stats.ocr.fail++;
        }
      }
    }
    console.log("[backfill] OCR:", JSON.stringify(stats.ocr));
  }

  await sql.end({ timeout: 5 });
  console.log("[backfill] complete:", JSON.stringify(stats));
}

main().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
