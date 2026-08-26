#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Plexo Connection & Profile Standard — conformance drift-guard.
 *
 * Fails (exit 1) if this app drifts from the standard:
 *   1. A forbidden AI-provider package appears in package.json deps/devDeps.
 *      Apps must route ALL AI through Plexo Core via @joeybuilt/plexo-sdk —
 *      never pin a provider/model locally.
 *   2. A source file imports a Plexo core internal (`@plexo/*`). Only the
 *      public SDK `@joeybuilt/plexo-sdk` is allowed.
 *
 * Plain Node ESM, zero dependencies — runs standalone in CI without install.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Forbidden provider/AI packages (exact names or scope/prefix globs) ───────
// NOTE: @anthropic-ai/sdk is intentionally ALLOWED in Fonto as the embedded
// Completion tier floor (lib/intelligence/adapters/anthropic.ts via
// FONTO_LLM_KEY) with federated Plexo as preferred. See ADR-002 + lib/intelligence/registry.ts.
const FORBIDDEN_PKGS = [
  "openai",
  "anthropic",
  "ai", // Vercel AI SDK
  "@ai-sdk/*",
  "ollama",
  "@huggingface/*",
  "transformers",
  "onnxruntime*",
  "tesseract.js",
  "@supabase/*",
];

function matchesPattern(name, pattern) {
  if (pattern.endsWith("/*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

const violations = [];

// ── (1) package.json deps scan ───────────────────────────────────────────────
const pkgPath = join(ROOT, "package.json");
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  for (const name of Object.keys(deps)) {
    for (const pattern of FORBIDDEN_PKGS) {
      if (matchesPattern(name, pattern)) {
        violations.push(
          `package.json: forbidden dependency "${name}" (matched "${pattern}") — route AI through @joeybuilt/plexo-sdk, not a pinned provider`,
        );
      }
    }
  }
}

// ── (2) source import scan ───────────────────────────────────────────────────
const SCAN_DIRS = ["app", "lib", "src"];
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IMPORT_RE = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (SOURCE_EXT.has(extname(full))) {
      const src = readFileSync(full, "utf8");
      let m;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1];
        if (spec === "@plexo" || spec.startsWith("@plexo/")) {
          violations.push(
            `${full.slice(ROOT.length + 1)}: imports core internal "${spec}" — only @joeybuilt/plexo-sdk is allowed`,
          );
        }
      }
    }
  }
}

for (const d of SCAN_DIRS) {
  const full = join(ROOT, d);
  if (existsSync(full)) walk(full);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error("Plexo conformance guard FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log("Plexo conformance guard OK — no provider deps, no core-internal imports.");
process.exit(0);
