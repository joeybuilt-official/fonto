// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto sc list` — enumerate the caller's smart collections.
// `fonto sc run <id>` — execute one and print its current asset roster.
//
// The execute endpoint lives at /api/v1/smart-collections/:id/assets and
// returns the same asset shape the grid uses, so we reuse the ls
// formatter for symmetry.

import chalk from "chalk";
import Table from "cli-table3";
import { request, ApiError, type Asset } from "../api.js";

interface SmartCollection {
  id: string;
  name: string;
  query: unknown;
  createdAt: string;
}

export interface ScListOpts {
  json?: boolean;
}

export async function scList(opts: ScListOpts): Promise<void> {
  try {
    const { smartCollections } = await request<{
      smartCollections: SmartCollection[];
    }>("/api/v1/smart-collections");
    if (opts.json) {
      console.log(JSON.stringify(smartCollections, null, 2));
      return;
    }
    if (smartCollections.length === 0) {
      console.log(chalk.dim("(no smart collections — create them in /app/smart-collections)"));
      return;
    }
    const table = new Table({
      head: ["id", "name", "created"].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [10, 40, 20],
      wordWrap: true,
    });
    for (const sc of smartCollections) {
      table.push([
        chalk.dim(sc.id.slice(0, 8)),
        sc.name,
        new Date(sc.createdAt).toISOString().slice(0, 10),
      ]);
    }
    console.log(table.toString());
    console.log(
      chalk.dim(
        `${smartCollections.length} smart collection${smartCollections.length === 1 ? "" : "s"}`
      )
    );
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(chalk.red(`✗ ${err.status} ${err.message}`));
    } else {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}

export interface ScRunOpts {
  json?: boolean;
  limit?: string;
}

export async function scRun(id: string, opts: ScRunOpts): Promise<void> {
  try {
    const sp = new URLSearchParams();
    if (opts.limit) sp.set("limit", opts.limit);
    const q = sp.toString();
    const { assets } = await request<{ assets: Asset[] }>(
      `/api/v1/smart-collections/${id}/assets${q ? `?${q}` : ""}`
    );
    if (opts.json) {
      console.log(JSON.stringify(assets, null, 2));
      return;
    }
    if (assets.length === 0) {
      console.log(chalk.dim("(no assets match)"));
      return;
    }
    const table = new Table({
      head: ["id", "filename", "type", "captured"].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [10, 40, 18, 20],
      wordWrap: true,
    });
    for (const a of assets) {
      table.push([
        chalk.dim(a.id.slice(0, 8)),
        a.filename,
        a.classification ?? a.mimeType,
        a.capturedAt ? new Date(a.capturedAt).toISOString().slice(0, 10) : "—",
      ]);
    }
    console.log(table.toString());
    console.log(chalk.dim(`${assets.length} asset${assets.length === 1 ? "" : "s"}`));
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(chalk.red(`✗ ${err.status} ${err.message}`));
    } else {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}
