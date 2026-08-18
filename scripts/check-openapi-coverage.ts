// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Diffs the OpenAPI registry against the actual filesystem of route handlers.
// Run with: `tsx scripts/check-openapi-coverage.ts`
//
// This is a soft check: it prints a warning summary and exits non-zero only
// when invoked with `--strict` (so CI can decide whether to fail).
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { REGISTERED_ROUTES } from "@/lib/openapi/routes";

const ROOT = process.cwd();
const APP_API = join(ROOT, "app", "api", "v1");

type FoundRoute = { method: string; path: string; file: string };

/** Walk `app/api/v1` recursively and return every `route.ts` file. */
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

/** Turn `app/api/v1/assets/[id]/route.ts` into `/api/v1/assets/{id}`. */
function fileToOpenApiPath(file: string): string {
  const rel = relative(join(ROOT, "app"), file).replace(/\\/g, "/");
  const segments = rel
    .replace(/\/route\.ts$/, "")
    .split("/")
    .map((seg) => {
      // Drop catch-all and optional-catch-all segments; replace `[id]` -> `{id}`.
      if (seg.startsWith("[[...") || seg.startsWith("[...")) {
        return `{${seg.replace(/^\[\[?\.{3}|\]\]?$/g, "")}}`;
      }
      if (seg.startsWith("[") && seg.endsWith("]")) {
        return `{${seg.slice(1, -1)}}`;
      }
      return seg;
    });
  return "/" + segments.join("/");
}

/** Crude regex over the file source to discover exported HTTP methods. */
async function extractMethods(file: string): Promise<string[]> {
  const src = await readFile(file, "utf8");
  const methods: string[] = [];
  const re =
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) methods.push(m[1]);
  return [...new Set(methods)];
}

async function main() {
  const files = await findRouteFiles(APP_API);
  const found: FoundRoute[] = [];
  for (const file of files) {
    const path = fileToOpenApiPath(file);
    const methods = await extractMethods(file);
    for (const method of methods) found.push({ method, path, file });
  }

  const foundKeys = new Set(found.map((r) => `${r.method} ${r.path}`));
  const registered = new Set(REGISTERED_ROUTES);

  // tus catch-all: app/api/v1/uploads/tus/[[...path]]/route.ts exports
  // GET/POST/PATCH/DELETE. The registry expands it into specific paths, so
  // strip the wildcard line item from the "found" set for the diff and
  // re-add the expanded forms.
  const tusWildcardPath = "/api/v1/uploads/tus/{path}";
  const tusFoundForWildcard = [...foundKeys].filter((k) =>
    k.endsWith(` ${tusWildcardPath}`)
  );
  for (const k of tusFoundForWildcard) foundKeys.delete(k);
  // What the registry actually documents for tus:
  for (const k of [
    "POST /api/v1/uploads/tus",
    "PATCH /api/v1/uploads/tus/{uploadId}",
    "GET /api/v1/uploads/tus/{uploadId}",
    "DELETE /api/v1/uploads/tus/{uploadId}",
  ]) {
    foundKeys.add(k);
  }

  // Intentional exclusions from the diff: routes that exist on disk but
  // should not appear in the registry (the spec itself, etc.).
  const IGNORED = new Set<string>(["GET /api/v1/openapi.json"]);
  const missing = [...foundKeys]
    .filter((k) => !registered.has(k) && !IGNORED.has(k))
    .sort();
  const extra = [...registered].filter((k) => !foundKeys.has(k)).sort();

  console.log(`OpenAPI coverage: ${registered.size} registered / ${foundKeys.size} found on disk`);
  if (missing.length) {
    console.warn(`\nMissing from registry (${missing.length}):`);
    for (const k of missing) console.warn(`  - ${k}`);
  }
  if (extra.length) {
    console.warn(`\nRegistered but not on disk (${extra.length}):`);
    for (const k of extra) console.warn(`  - ${k}`);
  }
  if (!missing.length && !extra.length) {
    console.log("All routes covered.");
  }

  if (process.argv.includes("--strict") && (missing.length || extra.length)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
