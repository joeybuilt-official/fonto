// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Endpoint-test coverage gate: every /api/v1 route handler must have a matching
// test, and legacy gaps live in a shrink-only allowlist.
//
// Run with: `pnpm tsx scripts/check-endpoint-tests.ts`
//
// Mechanics (see .claude/rules/testing.md → "Enforced endpoint test coverage"):
//   1. The endpoint list is anchored to the manifest the application itself uses
//      (REGISTERED_ROUTES in lib/openapi/routes.ts), cross-referenced against the
//      handler files under app/api/v1 (the same walk check-openapi-coverage.ts uses).
//   2. A handler file is "covered" when a test file (route.test.ts / *.spec.ts)
//      is colocated in the same directory — the mechanical mirror mapping.
//   3. Handlers with no test must be listed in scripts/endpoint-test-allowlist.yaml
//      (one repo-relative path per line). The allowlist is shrink-only: net-new
//      entries vs the committed version fail the check.
import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { REGISTERED_ROUTES } from "@/lib/openapi/routes";

const ROOT = process.cwd();
const APP_API = join(ROOT, "app", "api", "v1");
const ALLOWLIST_FILE = "scripts/endpoint-test-allowlist.yaml";

async function findRouteFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findRouteFiles(full)));
    } else if (entry.isFile() && entry.name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

async function siblingTestExists(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) =>
      e.isFile() &&
      e.name !== "route.ts" &&
      /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(e.name),
  );
}

/** `/api/v1/assets/{id}` → segments like `["assets", "[id]"]`. */
function registeredSegments(rel: string): string[] {
  return rel
    .replace(/^\/api\/v1\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith("{") && seg.endsWith("}")) {
        return `[${seg.slice(1, -1)}]`;
      }
      return seg;
    });
}

/** Static (non-dynamic) leading segments of a registered path. */
function staticPrefix(segs: string[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s.startsWith("[")) break;
    out.push(s);
  }
  return out;
}

function readAllowlist(): Set<string> {
  try {
    return new Set(
      readFileSync(join(ROOT, ALLOWLIST_FILE), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#")),
    );
  } catch {
    return new Set();
  }
}

function committedAllowlist(): { entries: Set<string>; exists: boolean } {
  try {
    const out = execFileSync("git", ["show", `HEAD:${ALLOWLIST_FILE}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      entries: new Set(
        out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#")),
      ),
      exists: true,
    };
  } catch {
    // Not committed yet (fresh scaffold) — there is no committed baseline, so the
    // shrink-only check is a no-op until the seeded allowlist lands in HEAD.
    return { entries: new Set(), exists: false };
  }
}

async function main() {
  const files = await findRouteFiles(APP_API);
  const handlerFiles = [...new Set(files)].sort();

  const allowlist = readAllowlist();
  const allowlisted = handlerFiles.filter((f) =>
    allowlist.has(relative(ROOT, f)),
  );

  // 1. Every registered route must resolve to a real handler file. Catch-all
  //    expansions (tus, `{...path}`) resolve to the static prefix subtree, so a
  //    registered route with no implementation anywhere under its prefix fails.
  const unresolved: string[] = [];
  for (const key of REGISTERED_ROUTES) {
    const segs = registeredSegments(key.slice(key.indexOf(" ") + 1));
    const literal = join(ROOT, "app", "api", "v1", ...segs, "route.ts");
    if (existsSync(literal)) continue;
    const prefix = staticPrefix(segs);
    if (prefix.length && (await findRouteFiles(join(ROOT, "app", "api", "v1", ...prefix))).length) {
      continue;
    }
    unresolved.push(key.slice(key.indexOf(" ") + 1));
  }

  // 2. Gaps: handler files with no sibling test and no allowlist entry.
  const gaps: string[] = [];
  for (const f of handlerFiles) {
    const rel = relative(ROOT, f);
    if (await siblingTestExists(join(f, ".."))) continue;
    if (allowlist.has(rel)) continue;
    gaps.push(rel);
  }

  // 3. Shrink-only allowlist: net-new entries vs the committed version fail.
  const committed = committedAllowlist();
  const netNew = committed.exists
    ? [...allowlist].filter((p) => !committed.entries.has(p)).sort()
    : [];

  console.log(
    `Endpoint coverage: ${handlerFiles.length} handlers / ${handlerFiles.length - gaps.length - allowlisted.length} tested / ` +
      `${allowlisted.length} allowlisted / ${gaps.length} gaps`,
  );

  let fail = 0;
  if (unresolved.length) {
    fail = 1;
    console.warn(`\nRegistered routes with no handler file on disk (${unresolved.length}):`);
    for (const p of unresolved) console.warn(`  - ${p}`);
    console.warn("  Write the missing handler, or remove it from lib/openapi/routes.ts.");
  }
  if (gaps.length) {
    fail = 1;
    console.warn(`\nHandlers without a matching test (${gaps.length}):`);
    for (const p of gaps) console.warn(`  - ${p}`);
    console.warn("  Write a colocated test, or add the path to scripts/endpoint-test-allowlist.yaml");
  }
  if (netNew.length) {
    fail = 1;
    console.warn(`\nAllowlist grew vs HEAD (${netNew.length} net-new entries — shrink-only):`);
    for (const p of netNew) console.warn(`  - ${p}`);
    console.warn("  Write the test instead of adding to the allowlist.");
  }
  if (fail) process.exit(1);
  console.log("All endpoint handlers covered.");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
