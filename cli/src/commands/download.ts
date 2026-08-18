// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto download <id>` — fetch the original via the batch-URL endpoint
// (single-id batch is fine; same auth + scoping as the grid renderer)
// and stream it to disk. Defaults to writing the server-side filename
// into the cwd; `--out <path>` overrides the destination.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import chalk from "chalk";
import ora from "ora";
import { request, ApiError, type Asset } from "../api.js";
import { getConfig } from "../config.js";

export interface DownloadOpts {
  out?: string;
  variant?: "thumb" | "preview" | "original";
}

export async function download(id: string, opts: DownloadOpts): Promise<void> {
  const variant = opts.variant ?? "original";
  const spin = ora(`Resolving ${id.slice(0, 8)}…`).start();

  let dest: string | undefined;
  let opened = false;
  try {
    const meta = await request<{ asset: Asset }>(`/api/v1/assets/${id}`);
    const batch = await request<{
      urls: Record<string, string>;
      variants: Record<string, string>;
    }>(`/api/v1/assets/urls`, {
      method: "POST",
      body: JSON.stringify({ ids: [id], variant }),
    });
    const url = batch.urls[id];
    if (!url) {
      spin.fail(`No URL returned for ${id} (deleted or no access?)`);
      process.exitCode = 1;
      return;
    }

    // `meta.asset.filename` is server-controlled; strip any path components
    // so a hostile filename (e.g. `../../.ssh/authorized_keys`) can't write
    // outside the cwd. `--out` is caller-supplied and kept verbatim.
    dest = opts.out ?? path.basename(meta.asset.filename);
    spin.text = `Downloading → ${dest}`;

    // Presigned R2 URL — fetched without our Bearer header (R2 rejects it).
    const cfg = getConfig();
    const res = await fetch(url, {
      headers: { "User-Agent": `fonto-cli (${cfg.baseUrl})` },
    });
    if (!res.ok || !res.body) {
      spin.fail(`Storage fetch failed: ${res.status} ${res.statusText}`);
      process.exitCode = 1;
      return;
    }
    await fs.promises.mkdir(path.dirname(path.resolve(dest)), { recursive: true });
    const file = fs.createWriteStream(dest);
    opened = true;
    // Response.body is a web ReadableStream — bridge it to a Node Readable
    // so the pipeline picks the node:stream overload (avoids the
    // ambiguous-overload TS error on the web-pipeline form).
    const nodeStream = Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
    await pipeline(nodeStream, file);

    const stat = await fs.promises.stat(dest);
    spin.succeed(
      `${chalk.cyan(dest)} ${chalk.dim(`(${(stat.size / 1024).toFixed(1)} KB)`)}`
    );
  } catch (err) {
    spin.fail();
    // A mid-transfer failure leaves a truncated file on disk; remove it so a
    // later read can't mistake the partial for a complete download.
    if (opened && dest) {
      await fs.promises.unlink(dest).catch(() => {});
    }
    if (err instanceof ApiError) {
      console.error(chalk.red(`✗ ${err.status} ${err.message}`));
    } else {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}
