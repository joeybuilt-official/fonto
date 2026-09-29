#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Fleet-decoupling conformance guard.
 *
 * Fails (exit 1) if Fonto re-acquires an internal dependency on a sibling
 * Joeybuilt app. Three families of violation are caught:
 *
 *   1. A sibling SDK appears as a dependency in package.json, or a pinned
 *      AI-provider package the app is not allowed to carry.
 *   2. A source file imports a removed Fonto-internal bridge to a sibling app,
 *      or a sibling's published package.
 *   3. A source file references a sibling app's environment variables — the
 *      tell-tale of a hidden runtime coupling that no import map reveals.
 *
 * WHAT IS ALLOWED, deliberately: reaching a peer over the wire. A URL, a
 * hostname, or an HTTP call to a peer's PUBLIC API is the whole point of the
 * decoupling — Fonto pairs through published interfaces (see
 * `public/.well-known/jex.manifest.json`). This guard blocks internal
 * coupling, not integration.
 *
 * `@anthropic-ai/sdk` stays ALLOWED: it is the embedded Completion tier floor
 * (`lib/intelligence/adapters/anthropic.ts`), reached with the deployment's or
 * the user's own key — never a sibling app's credential.
 *
 * Rule 4 (asset LIST projection whitelist) is unchanged and still enforced.
 *
 * Plain Node ESM, zero dependencies — runs standalone in CI before any install.
 *
 * Usage:  node scripts/conformance-guard.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── (1) Forbidden packages (exact names or scope/prefix globs) ───────────────
// Sibling-app SDKs, plus AI-provider packages that would re-introduce a pinned
// model/provider coupling. `@anthropic-ai/sdk` is deliberately absent — it is
// the embedded tier floor, configured per deployment/user, not a sibling path.
const FORBIDDEN_PKGS = [
  "@joeybuilt/plexo-sdk",
  "@joeybuilt/fylo-sdk",
  "@joeybuilt/levio-sdk",
  "@joeybuilt/depona-sdk",
  "@joeybuilt/nexalog-sdk",
  "openai",
  "anthropic", // bare name; @anthropic-ai/sdk is the allowed embedded floor
  "ai", // Vercel AI SDK
  "@ai-sdk/*",
  "ollama",
  "@huggingface/*",
  "transformers",
  "onnxruntime*",
  "tesseract.js",
  "@supabase/*",
];

// ── (2) Forbidden import specifiers ──────────────────────────────────────────
// Modules that used to bridge into a sibling app. They were deleted; an import
// of one means a half-migration reintroduced a local coupling.
const FORBIDDEN_IMPORTS = [
  "@/lib/plexo",
  "@/lib/plexo-registration",
  "@/lib/plexo-vision",
  "@/lib/intelligence/adapters/plexo-unified",
  "@/lib/intelligence/adapters/plexo-federated",
  "@joeybuilt/plexo-sdk",
];

// ── (3) Forbidden env var names ──────────────────────────────────────────────
// A sibling app's server-side credentials/config. Fonto owns its own keys
// (FONTO_*) and its own AI connection config (AI_*/FONTO_LLM_*).
const FORBIDDEN_ENV_RE = /\bPLEXO_[A-Z0-9_]+/g;

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
          `package.json: forbidden dependency "${name}" (matched "${pattern}") — route AI through the app-owned tiers, never a sibling SDK or a pinned provider`,
        );
      }
    }
  }
}

// ── (2) source scan for sibling imports / env references ─────────────────────
const SCAN_DIRS = ["app", "lib", "worker", "scripts", "cli", "packages", "components", "ops"];
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts"]);
const IMPORT_RE = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)[\"']([^\"']+)[\"']/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "dist" ||
      entry === "coverage"
    ) {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Drizzle snapshots are immutable history — never rewritten, never flagged.
      if (full.includes(`${join("drizzle", "meta")}`)) continue;
      walk(full);
    } else if (SOURCE_EXT.has(extname(full))) {
      // Skip this guard itself — it names the forbidden strings in order to
      // ban them and must not flag its own enforcement text.
      if (full === fileURLToPath(import.meta.url)) continue;
      const src = readFileSync(full, "utf8");
      let m;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1];
        for (const forbidden of FORBIDDEN_IMPORTS) {
          if (spec === forbidden || spec.startsWith(`${forbidden}/`)) {
            violations.push(
              `${full.slice(ROOT.length + 1)}: imports removed sibling module "${spec}" — pair over the published API/MCP surface instead`,
            );
          }
        }
      }
      const envMatches = src.match(FORBIDDEN_ENV_RE);
      if (envMatches) {
        violations.push(
          `${full.slice(ROOT.length + 1)}: references sibling env var(s) ${[...new Set(envMatches)].join(", ")} — an app owns its own config`,
        );
      }
    }
  }
}

for (const d of SCAN_DIRS) {
  const full = join(ROOT, d);
  if (existsSync(full)) walk(full);
}

// ── (3) asset LIST projection whitelist ──────────────────────────────────────
// Columns `assetGridColumns()` (lib/assets/createAssetRow.ts) is allowed to put
// on the wire for grid/timeline list responses. To add one deliberately: confirm
// the column is small enough to ship on EVERY row of EVERY library page, then
// add its name below in the same change.
const LIST_PROJECTION_WHITELIST = new Set([
  "id", "workspaceId", "filename", "mimeType", "sizeBytes", "sha256",
  "syncState", "processingState", "lifecycleState", "source",
  "classification", "facesIgnored", "description", "correspondentId",
  "documentTypeId", "capturedAt", "deletedAt", "archivedAt", "purgedAt",
  "phash", "colors", "ocrState", "ocrBoxes", "exif", "latitude", "longitude",
  "placeName", "cameraMake", "cameraModel", "lensModel", "focalLength",
  "fNumber", "iso", "exposureTime", "orientation", "widthPx", "heightPx",
  "processingError", "processingAttempts", "thumbnailKey", "previewKey",
  "thumbnail256AvifKey", "thumbnail512WebpKey", "thumbnail512AvifKey",
  "thumbnail1024WebpKey", "thumbnail1024AvifKey", "previewAvifKey",
  "thumbnailGeneratedAt", "lqip", "createdAt", "updatedAt", "seq",
  "isFavorite", "rating", "directoryPath", "clipDedupCheckedAt",
  "subClassification", "classifyMethod", "classifyConfidence", "autoTaggedAt",
  "stackId", "durationSeconds", "videoCodec", "videoWidth", "videoHeight",
  "hlsState", "hlsMasterKey", "hlsRenditions", "spriteKey", "spriteMeta",
  "pageCount", "kind", "scope", "shootId", "shootStage",
  "storagePolicyOverride", "localOriginalStoredAt", "derivedFromAssetId",
  "variantGroupId", "isCanonical", "qualityMetrics", "consolidationState",
  "trashPurgeAt", "motionPhoto", "motionVideoKey", "motionCompanionAssetId",
  "motionCompanion",
  // Derived boolean (not a column): thumbnail_state = 'skipped'. One bit per
  // row, added deliberately in the same change as its reader — the Phase 4
  // "preview unavailable" tile. Ships instead of the raw thumbnailState and
  // thumbnailError, both of which stay off the list projection.
  "previewUnavailable",
]);

const ASSETS_TABLE_ANCHOR = "export const assets = fontoSchema.table(";
const GRID_FN_ANCHOR = "export function assetGridColumns()";

function stripLiterals(line) {
  return line
    .replace(/`[^`]*`/g, "``")
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/\/\/.*$/, "");
}

// Keys of the first object literal after `anchor`, top level only. Shorthand
// (`{ thumbUrl }`) counts as a key; spreads and nested keys do not.
function objectKeys(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return [];
  const text = src
    .slice(at)
    .split("\n")
    .map(stripLiterals)
    .join("\n");
  const start = text.indexOf("{");
  if (start === -1) return [];
  const keys = [];
  let depth = 0;
  let buf = "";
  let sawColon = false;
  const flush = () => {
    if (!sawColon && /^[A-Za-z_$][\w$]*$/.test(buf.trim())) keys.push(buf.trim());
    buf = "";
    sawColon = false;
  };
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
      buf = "";
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        flush();
        break;
      }
      buf = "";
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ",") {
      flush();
    } else if (ch === ":" && !sawColon) {
      if (/^[A-Za-z_$][\w$]*$/.test(buf.trim())) keys.push(buf.trim());
      buf = "";
      sawColon = true;
    } else {
      buf += ch;
    }
  }
  return keys;
}

const schemaPath = join(ROOT, "lib", "db", "schema.ts");
const projectionPath = join(ROOT, "lib", "assets", "createAssetRow.ts");
if (existsSync(schemaPath) && existsSync(projectionPath)) {
  const tableColumns = objectKeys(readFileSync(schemaPath, "utf8"), ASSETS_TABLE_ANCHOR);
  const projectionSrc = readFileSync(projectionPath, "utf8");
  const fnAt = projectionSrc.indexOf(GRID_FN_ANCHOR);
  if (tableColumns.length === 0 || fnAt === -1) {
    violations.push(
      `scripts/conformance-guard.mjs: cannot find the asset list projection (${ASSETS_TABLE_ANCHOR} / ${GRID_FN_ANCHOR}) — the guard needs updating`,
    );
  } else {
    const fnEnd = projectionSrc.indexOf("\n}", fnAt);
    const body = projectionSrc.slice(fnAt, fnEnd === -1 ? undefined : fnEnd);
    const omitted = new Set(
      (/\{([^{}]*)\}\s*=\s*getTableColumns\(/.exec(body)?.[1] ?? "")
        .split(",")
        .map((part) => part.split(":")[0].trim())
        .filter((name) => name && !name.startsWith("...")),
    );
    const projected = new Set([
      ...tableColumns.filter((col) => !omitted.has(col)),
      ...objectKeys(body, "return {"),
    ]);
    for (const col of projected) {
      if (!LIST_PROJECTION_WHITELIST.has(col)) {
        violations.push(
          `lib/assets/createAssetRow.ts: asset list projection selects "${col}" — every library page pays for it on every row. Omit it in assetGridColumns(), or add the column to LIST_PROJECTION_WHITELIST in scripts/conformance-guard.mjs if this is intentional`,
        );
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error("Fleet-decoupling conformance guard FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(
  "Fleet-decoupling conformance guard OK — no sibling deps, no sibling imports, no sibling env, asset list projection within whitelist.",
);
process.exit(0);
