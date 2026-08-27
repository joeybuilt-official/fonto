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
 *   3. The asset LIST projection (assetGridColumns) selects a column that is
 *      not on the reviewed whitelist — every extra column ships on every row
 *      of every library page.
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
  console.error("Plexo conformance guard FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(
  "Plexo conformance guard OK — no provider deps, no core-internal imports, asset list projection within whitelist.",
);
process.exit(0);
