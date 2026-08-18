// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto stacks list`        — existing stacks (primary asset + member count).
// `fonto stacks suggestions` — read-only suggestor output (raw+jpeg, burst).
// `fonto stacks accept <ids…>` — POST /stacks/suggestions/accept to commit a group.

import chalk from "chalk";
import Table from "cli-table3";
import { request, ApiError } from "../api.js";

interface StackRow {
  id: string;
  name: string | null;
  primaryAssetId: string;
  primaryFilename: string | null;
  memberCount: number;
  createdAt: string;
}

interface Suggestion {
  assetIds: string[];
  reason: "raw+jpeg" | "burst";
}

export interface StacksListOpts {
  json?: boolean;
}

export async function stacksList(opts: StacksListOpts): Promise<void> {
  try {
    const { stacks } = await request<{ stacks: StackRow[] }>("/api/v1/stacks");
    if (opts.json) {
      console.log(JSON.stringify(stacks, null, 2));
      return;
    }
    if (stacks.length === 0) {
      console.log(chalk.dim("(no stacks — try `fonto stacks suggestions`)"));
      return;
    }
    const table = new Table({
      head: ["id", "name", "primary", "members", "created"].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [10, 24, 30, 9, 12],
      wordWrap: true,
    });
    for (const s of stacks) {
      table.push([
        chalk.dim(s.id.slice(0, 8)),
        s.name ?? chalk.dim("—"),
        s.primaryFilename ?? chalk.dim(s.primaryAssetId.slice(0, 8)),
        String(s.memberCount),
        new Date(s.createdAt).toISOString().slice(0, 10),
      ]);
    }
    console.log(table.toString());
    console.log(chalk.dim(`${stacks.length} stack${stacks.length === 1 ? "" : "s"}`));
  } catch (err) {
    fail(err);
  }
}

export interface StacksSuggestOpts {
  json?: boolean;
  limit?: string;
}

export async function stacksSuggestions(opts: StacksSuggestOpts): Promise<void> {
  try {
    const { suggestions, total } = await request<{
      suggestions: Suggestion[];
      total: number;
    }>("/api/v1/stacks/suggestions");

    const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10)) : suggestions.length;
    const slice = suggestions.slice(0, limit);

    if (opts.json) {
      console.log(JSON.stringify(slice, null, 2));
      return;
    }
    if (slice.length === 0) {
      console.log(chalk.dim("(no suggestions — try processing more assets)"));
      return;
    }
    const table = new Table({
      head: ["#", "reason", "members", "assetIds (short)"].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [4, 12, 9, 60],
      wordWrap: true,
    });
    slice.forEach((s, i) => {
      table.push([
        String(i + 1),
        s.reason,
        String(s.assetIds.length),
        s.assetIds.map((id) => id.slice(0, 8)).join(" "),
      ]);
    });
    console.log(table.toString());
    console.log(
      chalk.dim(
        `${slice.length} shown · ${total} total · accept with \`fonto stacks accept <id> <id> …\``
      )
    );
  } catch (err) {
    fail(err);
  }
}

export interface StacksAcceptOpts {
  primary?: string;
  name?: string;
  json?: boolean;
}

export async function stacksAccept(
  assetIds: string[],
  opts: StacksAcceptOpts
): Promise<void> {
  if (assetIds.length < 2) {
    console.error(chalk.red("✗ stacks need ≥2 asset ids"));
    process.exitCode = 2;
    return;
  }
  try {
    const body: Record<string, unknown> = { assetIds };
    if (opts.primary) body.primaryAssetId = opts.primary;
    if (opts.name) body.name = opts.name;

    const res = await request<{
      stack: { id: string; name: string | null };
      assetIds: string[];
    }>("/api/v1/stacks/suggestions/accept", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(
      chalk.green(`✓ stack ${res.stack.id.slice(0, 8)}`) +
        chalk.dim(
          ` ${res.assetIds.length} members${res.stack.name ? ` "${res.stack.name}"` : ""}`
        )
    );
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
