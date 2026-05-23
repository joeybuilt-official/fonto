// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.2 — download the full GeoNames cities500 dataset (~9 MB unzipped,
// ~190k populated places ≥500 residents) into `data/geonames/cities500.tsv`.
//
// The repo ships a ~50-line placeholder so the geocoder code path can run in
// CI / local dev. Production deploys overlay the real file by invoking this
// script once at image-build time (or at the first container boot):
//
//   pnpm tsx scripts/fetch-geonames.ts
//
// Idempotent: re-running overwrites the file in place. Requires `unzip` on
// PATH (Alpine: `apk add --no-cache unzip`).
//
// Source: https://download.geonames.org/export/dump/cities500.zip
// Licence: Creative Commons Attribution 4.0 — attribution rendered on the
// map page footer.

import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const URL = "https://download.geonames.org/export/dump/cities500.zip";
const DEST_DIR = path.join(process.cwd(), "data", "geonames");
const DEST_FILE = path.join(DEST_DIR, "cities500.tsv");

async function runUnzip(zipPath: string, outDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("unzip", ["-o", zipPath, "-d", outDir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  console.log(`[fetch-geonames] downloading ${URL}`);
  await mkdir(DEST_DIR, { recursive: true });

  const tmpDir = await import("node:fs/promises").then((m) =>
    m.mkdtemp(path.join(tmpdir(), "fonto-geonames-"))
  );
  const zipPath = path.join(tmpDir, "cities500.zip");

  try {
    const res = await fetch(URL);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }
    // Node 20+ `Response.body` is a web ReadableStream; convert to a Node
    // Readable so we can pipe straight to disk without buffering 9 MB in RAM.
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(zipPath)
    );
    console.log(`[fetch-geonames] downloaded to ${zipPath}`);

    await runUnzip(zipPath, tmpDir);
    const extractedTxt = path.join(tmpDir, "cities500.txt");
    await rename(extractedTxt, DEST_FILE);
    console.log(`[fetch-geonames] wrote ${DEST_FILE}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[fetch-geonames] failed:", err);
  process.exit(1);
});
