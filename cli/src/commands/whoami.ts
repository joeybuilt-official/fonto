// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto whoami` — confirms the saved PAT works by hitting the stats
// endpoint (cheap; one indexed aggregate; PAT-gated like every other
// /api/v1 route).

import chalk from "chalk";
import { getConfig } from "../config.js";
import { getStats, ApiError } from "../api.js";

export async function whoami(): Promise<void> {
  const cfg = getConfig();
  console.log(`base URL: ${chalk.cyan(cfg.baseUrl)}`);
  console.log(
    `PAT:      ${cfg.pat ? chalk.green("set") : chalk.red("(not set)")}`
  );
  if (!cfg.pat) {
    process.exitCode = 1;
    return;
  }
  try {
    const stats = await getStats();
    console.log(chalk.green("\n✓ Authenticated"));
    console.log(`  total assets:   ${stats.total.toLocaleString()}`);
    console.log(`  images:         ${stats.images.toLocaleString()}`);
    console.log(`  documents:      ${stats.documents.toLocaleString()}`);
    console.log(`  favorites:      ${stats.favorites.toLocaleString()}`);
    console.log(`  this month:     ${stats.thisMonth.toLocaleString()}`);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(chalk.red(`\n✗ Auth check failed: ${err.status} ${err.message}`));
    } else {
      console.error(chalk.red(`\n✗ Network error: ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}
