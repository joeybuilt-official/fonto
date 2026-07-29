// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto upload <file>` — multipart upload via the legacy POST
// /api/v1/assets endpoint. The direct-to-R2 init/PUT/complete path is
// the future home (audit + size cap), but for CLI v1 the simpler
// streaming multipart upload is enough — and matches what `curl -F`
// would do.

import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getConfig } from "../config.js";
import { ApiError } from "../api.js";

export interface UploadOpts {
  path?: string; // virtual folder path (X-Fonto-Path header)
  json?: boolean;
}

export async function upload(file: string, opts: UploadOpts): Promise<void> {
  if (!fs.existsSync(file)) {
    console.error(chalk.red(`file not found: ${file}`));
    process.exitCode = 2;
    return;
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    console.error(chalk.red(`not a regular file: ${file}`));
    process.exitCode = 2;
    return;
  }

  const cfg = getConfig();
  if (!cfg.pat) {
    console.error(chalk.red("No PAT. Run `fonto login --pat <token>` first."));
    process.exitCode = 2;
    return;
  }

  const filename = path.basename(file);
  const spin = ora(`Uploading ${filename} (${(stat.size / 1024).toFixed(1)} KB)…`).start();

  try {
    const buffer = await fs.promises.readFile(file);
    const blob = new Blob([new Uint8Array(buffer)]);
    const form = new FormData();
    form.set("file", blob, filename);
    form.set("source", "cli");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.pat}`,
    };
    if (opts.path) headers["X-Fonto-Path"] = opts.path;

    const res = await fetch(`${cfg.baseUrl}/api/v1/assets`, {
      method: "POST",
      body: form,
      headers,
    });
    const text = await res.text();
    if (!res.ok) {
      spin.fail();
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
      asset: { id: string; filename: string };
      deduplicated?: boolean;
      possibleDuplicate?: unknown;
    };

    if (opts.json) {
      spin.stop();
      console.log(text);
      return;
    }
    if (body.deduplicated) {
      spin.warn(`Deduped — existing asset ${chalk.dim(body.asset.id)}`);
    } else {
      spin.succeed(`Uploaded ${chalk.cyan(body.asset.filename)} ${chalk.dim(body.asset.id)}`);
    }
    if (body.possibleDuplicate) {
      console.log(chalk.yellow("  ⚠ possible near-duplicate detected — see /app/photos"));
    }
  } catch (err) {
    spin.fail();
    if (err instanceof ApiError) {
      console.error(chalk.red(`✗ ${err.status} ${err.message}`));
    } else {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}
