// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto ls` — lists assets in the caller's primary workspace as a
// table. Mirrors the `--mime` / `--favorite` / `--limit` filters the
// /api/v1/assets endpoint accepts.

import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { listAssets, type Asset, ApiError } from "../api.js";

export interface LsOpts {
  mime?: string;
  limit?: string;
  favorite?: boolean;
  json?: boolean;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function ls(opts: LsOpts): Promise<void> {
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    const n = Number.parseInt(opts.limit, 10);
    if (Number.isNaN(n)) {
      console.error(chalk.red(`✗ invalid --limit: ${opts.limit}`));
      process.exitCode = 2;
      return;
    }
    limit = Math.max(1, n);
  }
  const spin = opts.json ? null : ora("Loading assets…").start();
  try {
    const { assets } = await listAssets({
      mime: opts.mime,
      limit,
      favorite: opts.favorite,
    });
    spin?.stop();
    if (opts.json) {
      console.log(JSON.stringify(assets, null, 2));
      return;
    }
    if (assets.length === 0) {
      console.log(chalk.dim("(no assets)"));
      return;
    }
    const table = new Table({
      head: ["id", "filename", "type", "size", "captured"].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [10, 36, 18, 12, 20],
      wordWrap: true,
    });
    for (const a of assets as Asset[]) {
      table.push([
        chalk.dim(a.id.slice(0, 8)),
        a.filename,
        a.classification ?? a.mimeType,
        fmtBytes(a.sizeBytes),
        a.capturedAt ? new Date(a.capturedAt).toISOString().slice(0, 10) : "—",
      ]);
    }
    console.log(table.toString());
    console.log(chalk.dim(`${assets.length} asset${assets.length === 1 ? "" : "s"}`));
  } catch (err) {
    spin?.stop();
    if (err instanceof ApiError) {
      console.error(chalk.red(`✗ ${err.status} ${err.message}`));
    } else {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}
