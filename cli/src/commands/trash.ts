// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// `fonto trash <id...>` / `fonto restore <id...>` — toggle lifecycle on
// one or more assets via PATCH /api/v1/assets/:id. Errors are surfaced
// per-id but never abort the batch, so `fonto trash $(fonto search foo
// --json | jq -r '.assets[].id')` does the right thing even when one id
// 404s.

import chalk from "chalk";
import { request, ApiError } from "../api.js";

async function patchOne(
  id: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; err?: string }> {
  try {
    await request(`/api/v1/assets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, err: `${err.status} ${err.message}` };
    return { ok: false, err: (err as Error).message };
  }
}

async function run(ids: string[], body: Record<string, unknown>, verb: string): Promise<void> {
  if (ids.length === 0) {
    console.error(chalk.red(`✗ ${verb} requires at least one id`));
    process.exitCode = 2;
    return;
  }
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    const r = await patchOne(id, body);
    if (r.ok) {
      ok++;
      console.log(`${chalk.green("✓")} ${chalk.dim(id.slice(0, 8))} ${verb}d`);
    } else {
      fail++;
      console.log(`${chalk.red("✗")} ${chalk.dim(id.slice(0, 8))} ${r.err}`);
    }
  }
  console.log(chalk.dim(`${ok} ok, ${fail} failed`));
  if (fail > 0) process.exitCode = 1;
}

export async function trash(ids: string[]): Promise<void> {
  await run(ids, { trash: true }, "trash");
}

export async function restore(ids: string[]): Promise<void> {
  await run(ids, { restore: true }, "restore");
}
