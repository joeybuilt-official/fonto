// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto folder mv <path> <newParent>` — reparent a folder subtree.
// `fonto folder rm <path>`              — trash every asset under <path>
//                                         (or --orphan to clear paths instead).
//
// Folders in Fonto are derived: there are no folder rows, only a
// directory_path column on `assets`. Both ops POST to
// /api/v1/folders/operation with a discriminated `op` field.

import chalk from "chalk";
import { request, ApiError } from "../api.js";

interface OperationResponse {
  op: "rename" | "move" | "delete";
  path: string;
  affected: number;
  target?: string;
  newParent?: string;
  action?: string;
}

export interface FolderOpts {
  json?: boolean;
}

export interface FolderRmOpts extends FolderOpts {
  orphan?: boolean;
}

export async function folderMv(
  p: string,
  newParent: string,
  opts: FolderOpts
): Promise<void> {
  try {
    const res = await request<OperationResponse>(
      "/api/v1/folders/operation",
      {
        method: "POST",
        body: JSON.stringify({ op: "move", path: p, newParent }),
      }
    );
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(
      chalk.green(`✓ moved`) +
        chalk.dim(` ${p} → ${res.target ?? newParent} · ${res.affected} assets updated`)
    );
  } catch (err) {
    fail(err);
  }
}

export async function folderRm(p: string, opts: FolderRmOpts): Promise<void> {
  try {
    const action = opts.orphan ? "orphan" : "trash";
    const res = await request<OperationResponse>(
      "/api/v1/folders/operation",
      {
        method: "POST",
        body: JSON.stringify({ op: "delete", path: p, action }),
      }
    );
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (action === "trash") {
      console.log(
        chalk.green(`✓ trashed`) +
          chalk.dim(` ${p} · ${res.affected} assets sent to trash`)
      );
    } else {
      console.log(
        chalk.green(`✓ orphaned`) +
          chalk.dim(` ${p} · ${res.affected} assets moved to root`)
      );
    }
  } catch (err) {
    fail(err);
  }
}

function fail(err: unknown): void {
  if (err instanceof ApiError) {
    console.error(chalk.red(`✗ ${err.status} ${err.message}`));
  } else {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
  }
  process.exitCode = 1;
}
