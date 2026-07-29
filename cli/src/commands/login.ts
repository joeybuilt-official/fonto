// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto login --pat <token> [--base-url <url>]`
//
// PATs are minted at /app/settings/tokens in the web UI (session-only,
// see app/api/v1/tokens/route.ts). The CLI never mints — it just stores
// the existing token so subsequent commands can carry it.

import chalk from "chalk";
import { setBaseUrl, setPat, getConfig, configPath } from "../config.js";

export interface LoginOpts {
  pat?: string;
  baseUrl?: string;
}

export async function login(opts: LoginOpts): Promise<void> {
  if (opts.baseUrl) setBaseUrl(opts.baseUrl);
  if (!opts.pat) {
    console.error(
      chalk.red(
        "--pat <token> required. Mint one at /app/settings/tokens (UI)."
      )
    );
    process.exitCode = 2;
    return;
  }
  setPat(opts.pat);

  const cfg = getConfig();
  console.log(chalk.green("✓ Saved."));
  console.log(`  base URL: ${chalk.cyan(cfg.baseUrl)}`);
  console.log(`  config:   ${chalk.dim(configPath())}`);
}
