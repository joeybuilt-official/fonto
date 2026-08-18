// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot fixup for assets whose row exists but were left in syncState='syncing'
// after a pre-retry-harness import attempt: stream bytes from the source file,
// write to BOTH backends (idempotent), and bump syncState=synced.
//
// Usage:
//   tsx scripts/fixup-stuck-syncing.ts \
//     --workspace=<uuid> \
//     --pairs=/data/.../pairs.tsv   # each line: <assetId>\t<sourcePath>

import fs from "node:fs";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { detectMime } from "@/lib/mime";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";

function arg(name: string): string | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag === `--${name}`) return "";
  return flag.split("=").slice(1).join("=");
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 5,
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
        console.warn(`[fixup] ${label} attempt ${i + 1}/${attempts} failed (${msg}); retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const workspace = arg("workspace");
  const pairsPath = arg("pairs");
  if (!workspace || !pairsPath) {
    console.error("usage: --workspace=<uuid> --pairs=<tsv path>");
    process.exit(2);
  }
  const lines = fs
    .readFileSync(pairsPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let fixed = 0;
  let failed = 0;

  for (const line of lines) {
    const [assetId, sourcePath] = line.split("\t");
    if (!assetId || !sourcePath) {
      console.warn(`[fixup] bad line: ${line}`);
      failed++;
      continue;
    }
    try {
      // Re-resolve row to get filename + sync_state
      const rows = await db
        .select({
          id: schema.assets.id,
          filename: schema.assets.filename,
          syncState: schema.assets.syncState,
          mimeType: schema.assets.mimeType,
          sizeBytes: schema.assets.sizeBytes,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      if (rows.length === 0) {
        console.warn(`[fixup] row not found id=${assetId}`);
        failed++;
        continue;
      }
      const row = rows[0];
      const key = assetStorageKey(workspace, assetId, row.filename);

      // Check both backends
      let hasR2 = false;
      let hasLocal = false;
      try {
        await r2().stat(key);
        hasR2 = true;
      } catch {
        // missing
      }
      try {
        await localFs().stat(key);
        hasLocal = true;
      } catch {
        // missing
      }

      if (!hasR2 || !hasLocal) {
        const buf = fs.readFileSync(sourcePath);
        const sniffed = await detectMime(buf, row.mimeType || "", row.filename);
        const ct = sniffed?.mimeType || row.mimeType || "application/octet-stream";
        if (!hasR2) {
          await withRetry(`r2.put ${key}`, () =>
            r2().put(key, buf, { contentType: ct, contentLength: buf.length })
          );
          console.log(`[fixup] r2 put ${assetId} ${row.filename} (${buf.length}b)`);
        }
        if (!hasLocal) {
          await withRetry(`local.put ${key}`, () =>
            localFs().put(key, buf, { contentType: ct, contentLength: buf.length })
          );
          console.log(`[fixup] local put ${assetId} ${row.filename} (${buf.length}b)`);
        }
      } else {
        console.log(`[fixup] both backends present id=${assetId}; just bumping state`);
      }

      await db
        .update(schema.assets)
        .set({ syncState: "synced" })
        .where(eq(schema.assets.id, assetId));
      console.log(`[fixup] OK id=${assetId} ${row.filename}`);
      fixed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fixup] FAIL id=${assetId}: ${msg}`);
      failed++;
    }
  }

  console.log(`[fixup] done fixed=${fixed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
