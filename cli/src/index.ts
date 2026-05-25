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
import { download } from "./commands/download.js";
import { trash, restore } from "./commands/trash.js";
import { scList, scRun } from "./commands/smart-collection.js";
import { sync } from "./commands/sync.js";

const program = new Command();

program
  .name("fonto")
  .description("Fonto CLI — terminal interface to your Fonto instance")
  .version("0.2.0");

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

program
  .command("download <id>")
  .description("download an asset to disk")
  .option("--out <path>", "destination file (default: server-side filename in cwd)")
  .option("--variant <kind>", "thumb | preview | original (default original)")
  .action(async (id: string, opts) => {
    await download(id, opts);
  });

program
  .command("trash <ids...>")
  .description("move one or more assets to trash")
  .action(async (ids: string[]) => {
    await trash(ids);
  });

program
  .command("restore <ids...>")
  .description("restore one or more assets from trash")
  .action(async (ids: string[]) => {
    await restore(ids);
  });

const sc = program
  .command("sc")
  .description("smart-collection ops (list, run)");
sc.command("list")
  .description("list saved smart collections")
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    await scList(opts);
  });
sc.command("run <id>")
  .description("execute a smart collection and print matched assets")
  .option("--limit <n>", "cap row count")
  .option("--json", "raw JSON output")
  .action(async (id: string, opts) => {
    await scRun(id, opts);
  });

program
  .command("sync <dir>")
  .description("incremental upload of <dir> tree (one-way local → remote)")
  .option("--remote-prefix <path>", "virtual folder root on the remote (default /)")
  .option("--state <path>", "state file (default <dir>/.fonto-sync.json)")
  .option("--dry-run", "report what would upload without sending anything")
  .action(async (dir: string, opts) => {
    await sync(dir, opts);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(chalk.red(`fonto: ${err.message}`));
  process.exit(1);
});
