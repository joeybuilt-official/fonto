#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto CLI — `fonto <cmd>`. Thin client over the /api/v1 PAT-gated
// surface. Run `fonto --help` for the cmd list.

import { Command } from "commander";
import chalk from "chalk";
import { login } from "./commands/login.js";
import { whoami } from "./commands/whoami.js";
import { ls } from "./commands/ls.js";
import { search } from "./commands/search.js";
import { upload } from "./commands/upload.js";

const program = new Command();

program
  .name("fonto")
  .description("Fonto CLI — terminal interface to your Fonto instance")
  .version("0.1.0");

program
  .command("login")
  .description("save PAT + base URL (PATs are minted in the web UI at /app/settings/tokens)")
  .option("--pat <token>", "personal access token")
  .option("--base-url <url>", "fonto base URL (default https://myfonto.com)")
  .action(async (opts) => {
    await login(opts);
  });

program
  .command("whoami")
  .description("verify the saved PAT + show workspace stats")
  .action(async () => {
    await whoami();
  });

program
  .command("ls")
  .description("list assets in the workspace")
  .option("--mime <prefix>", "filter by mime prefix (e.g. image/, application/pdf)")
  .option("--favorite", "favorites only")
  .option("--limit <n>", "cap row count")
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    await ls(opts);
  });

program
  .command("search <query...>")
  .description("text search across filename / description / OCR text")
  .option("--json", "raw JSON output")
  .action(async (queryParts: string[], opts) => {
    await search(queryParts.join(" "), opts);
  });

program
  .command("upload <file>")
  .description("upload a single file via multipart")
  .option("--path <virtualPath>", "virtual folder path (e.g. /Photos/2024)")
  .option("--json", "raw JSON response")
  .action(async (file: string, opts) => {
    await upload(file, opts);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(chalk.red(`fonto: ${err.message}`));
  process.exit(1);
});
