// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto sc list` — enumerate the caller's smart collections.
// `fonto sc run <id>` — execute one and print its current asset roster.
// `fonto sc create <name> --query <file>` — POST a new smart collection.
//
// The execute endpoint lives at /api/v1/smart-collections/:id/assets and
// returns the same asset shape the grid uses, so we reuse the ls
// formatter for symmetry.

import fs from "node:fs";
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

export interface ScCreateOpts {
  query?: string;
  json?: boolean;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export async function scCreate(name: string, opts: ScCreateOpts): Promise<void> {
  try {
    let raw: string;
    if (opts.query) {
      if (!fs.existsSync(opts.query)) {
        throw new Error(`query file not found: ${opts.query}`);
      }
      raw = fs.readFileSync(opts.query, "utf8");
    } else if (!process.stdin.isTTY) {
      raw = await readStdin();
    } else {
      throw new Error("no --query <file> and stdin is a TTY — supply a JSON query");
    }
    let query: Record<string, unknown>;
    try {
      query = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`query JSON parse failed: ${(err as Error).message}`);
    }
    const res = await request<{ smartCollection: SmartCollection }>(
      "/api/v1/smart-collections",
      {
        method: "POST",
        body: JSON.stringify({ name, query }),
      }
    );
    if (opts.json) {
      console.log(JSON.stringify(res.smartCollection, null, 2));
      return;
    }
    console.log(
      chalk.green(`✓ created`) +
        chalk.dim(
          ` ${res.smartCollection.id.slice(0, 8)} "${res.smartCollection.name}"`
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
