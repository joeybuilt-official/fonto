// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto search <query>` — text + classification search via
// /api/v1/search (matches filename / description / OCR text). No CLIP /
// semantic in v1; the heuristic for "should we also fire CLIP" lives
// in the web UI and may eventually move into the server response so
// CLI callers get the same dual-result shape.

import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { search as apiSearch, type Asset, ApiError } from "../api.js";

export async function search(query: string, opts: { json?: boolean }): Promise<void> {
  if (!query || !query.trim()) {
    console.error(chalk.red("query required"));
    process.exitCode = 2;
    return;
  }
  const spin = opts.json ? null : ora(`Searching "${query}"…`).start();
  try {
    const { assets } = await apiSearch(query);
    spin?.stop();
    if (opts.json) {
      console.log(JSON.stringify(assets, null, 2));
      return;
    }
    if (assets.length === 0) {
      console.log(chalk.dim(`(no matches for "${query}")`));
      return;
    }
    const table = new Table({
      head: ["id", "filename", "type"].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [10, 50, 24],
      wordWrap: true,
    });
    for (const a of assets as Asset[]) {
      table.push([
        chalk.dim(a.id.slice(0, 8)),
        a.filename,
        a.classification ?? a.mimeType,
      ]);
    }
    console.log(table.toString());
    console.log(
      chalk.dim(`${assets.length} match${assets.length === 1 ? "" : "es"}`)
    );
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
