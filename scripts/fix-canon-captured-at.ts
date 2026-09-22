// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-time correction (2026-09-22, operator-approved) — give 43 mis-dated Canon
// videos their real shoot timestamp so they leave the fake `2026-01-01 12:00`
// bucket (6 Shakespeare camcorder clips) and the "Undated" bucket (37 Canon DSLR
// clips with `captured_at IS NULL`).
//
// Source of truth is the video container's own `creation_time`, read with
// ffprobe from the LOCAL MIRROR (header-only probe — the two 10.98 GB / 13.22 GB
// files are never decoded). File `mtime` is the fallback, and in practice never
// fires: all 43 rows carry an embedded time.
//
// Timezone convention: the wall-clock components are stored AS UTC, with no
// shift — exactly what `lib/exif.ts` does for every EXIF-derived row
// (`Date.UTC(y, mo-1, d, h ?? 12, …)`). Any trailing `Z` or `±hh:mm` on the
// probe value is therefore deliberately ignored: shifting these 43 would make
// them inconsistent with the rest of the library.
//
// This writes `assets.captured_at` directly rather than through the ADR-0005
// review-queue confirm route (`app/api/admin/review-queue/confirm/route.ts`),
// which is operator-initiated but writes `mapEstimate` — a DATE-only value that
// would discard the time-of-day we actually have, and would need fabricated
// `image_date_inference` rows first. None of the 43 has any `image_date_inference`
// or `image_date_evidence` row, and per ADR-0005 the worker never writes
// `captured_at`, so nothing re-fuses against this correction.
//
// Safety rails:
//   - aborts unless the predicate matches exactly `EXPECTED_ROWS` (43) rows;
//   - refuses to write any row whose derived date is outside `ALLOWED_DATES`, so
//     a surprise value means the set is wrong rather than silently stamped;
//   - aborts if any row's local original is missing or its size disagrees with
//     `size_bytes` (we would be probing the wrong bytes);
//   - writes an undo snapshot BEFORE mutating, with every prior value;
//   - the UPDATE is a compare-and-set on the prior `captured_at`, so a re-run is
//     a no-op and a concurrent change loses rather than being overwritten;
//   - `created_at` (ingest time) is never touched.
//
// Usage (from /app inside the worker container — ffprobe + LOCAL_STORAGE_ROOT
// live there):
//   npx tsx scripts/fix-canon-captured-at.ts                        # dry-run
//   npx tsx scripts/fix-canon-captured-at.ts --apply                # writes
//   npx tsx scripts/fix-canon-captured-at.ts --undo=/tmp/x.json     # snapshot path
//
// Reads DATABASE_URL + LOCAL_STORAGE_ROOT from env.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { assetStorageKey } from "@/lib/r2";

const EXPECTED_ROWS = 43;

// The two shoots the 37 undated Canon clips split into, plus the Shakespeare
// camcorder session. Verified against both the embedded creation_time and the
// staged file mtimes before this script was written.
const ALLOWED_DATES = new Set(["2026-05-09", "2024-05-04", "2026-04-23"]);

interface Row {
  id: string;
  filename: string;
  workspace_id: string;
  size_bytes: string;
  directory_path: string | null;
  captured_at: Date | null;
}

interface Planned extends Row {
  key: string;
  absPath: string;
  probeValue: string;
  probeSource: "container" | "stream" | "mtime";
  mtime: string;
  next: Date;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

/**
 * Resolve a storage key to an absolute path under LOCAL_STORAGE_ROOT, mirroring
 * `lib/storage/local-fs-backend.ts`'s traversal guard (that helper is
 * module-private, and this script must not widen it).
 */
function resolveLocal(key: string): string {
  const root = process.env.LOCAL_STORAGE_ROOT;
  if (!root) throw new Error("LOCAL_STORAGE_ROOT not configured");
  const base = path.resolve(root);
  const full = path.resolve(base, key);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`storage key escapes LOCAL_STORAGE_ROOT: ${key}`);
  }
  return full;
}

/**
 * Parse a probe value into wall-clock-as-UTC. Any trailing `Z` or `±hh:mm`
 * offset is intentionally discarded — see the timezone note in the header.
 */
function wallClockAsUtc(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function probe(absPath: string): { value: string; source: "container" | "stream" | "mtime" } {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_entries", "format_tags=creation_time",
        "-show_entries", "stream_tags=creation_time",
        absPath,
      ],
      { encoding: "utf8", timeout: 120_000 }
    );
    const j = JSON.parse(out) as {
      format?: { tags?: { creation_time?: unknown } };
      streams?: Array<{ tags?: { creation_time?: unknown } }>;
    };
    const fmt = j?.format?.tags?.creation_time;
    if (typeof fmt === "string" && fmt.trim()) return { value: fmt, source: "container" };
    const st = j?.streams?.[0]?.tags?.creation_time;
    if (typeof st === "string" && st.trim()) return { value: st, source: "stream" };
  } catch {
    // fall through to mtime — the documented fallback, not a hard failure
  }
  return { value: fs.statSync(absPath).mtime.toISOString(), source: "mtime" };
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const apply = flag("apply");
  const undoPath = arg("undo", "/tmp/canon-datefix-undo.json");
  const sql = postgres(dbUrl, { prepare: false });

  const rows = (await sql`
    SELECT id, filename, workspace_id, size_bytes, directory_path, captured_at
    FROM fonto.assets
    WHERE lifecycle_state = 'active'
      AND (
           (filename ~ '^MVI_01(3[6-9]|4[01])[.]MP4$' AND captured_at = '2026-01-01 12:00:00+00')
        OR (filename ~ '^MVI_93[0-9]{2}[.]MOV$'        AND captured_at IS NULL)
      )
    ORDER BY filename
  `) as unknown as Row[];

  console.log(
    `[fix-canon-captured-at] predicate matched ${rows.length} rows (expected ${EXPECTED_ROWS})`
  );
  if (rows.length !== EXPECTED_ROWS) {
    await sql.end();
    throw new Error(
      `row count ${rows.length} != expected ${EXPECTED_ROWS} — the target set has drifted; refusing to continue`
    );
  }

  const planned: Planned[] = [];
  const problems: string[] = [];
  for (const r of rows) {
    const key = assetStorageKey(r.workspace_id, r.id, r.filename);
    const absPath = resolveLocal(key);
    if (!fs.existsSync(absPath)) {
      problems.push(`${r.filename}: local original missing at ${absPath}`);
      continue;
    }
    const onDisk = fs.statSync(absPath).size;
    if (onDisk !== Number(r.size_bytes)) {
      problems.push(
        `${r.filename}: local size ${onDisk} != size_bytes ${r.size_bytes} — probing the wrong bytes`
      );
      continue;
    }
    const p = probe(absPath);
    const next = wallClockAsUtc(p.value);
    if (!next) {
      problems.push(`${r.filename}: unparseable probe value ${JSON.stringify(p.value)}`);
      continue;
    }
    if (!ALLOWED_DATES.has(isoDay(next))) {
      problems.push(
        `${r.filename}: derived date ${isoDay(next)} is not in the approved set {${[...ALLOWED_DATES].join(", ")}}`
      );
      continue;
    }
    planned.push({
      ...r,
      key,
      absPath,
      probeValue: p.value,
      probeSource: p.source,
      mtime: fs.statSync(absPath).mtime.toISOString(),
      next,
    });
  }

  if (problems.length) {
    await sql.end();
    throw new Error(
      `${problems.length} row(s) failed validation — no writes made:\n  ${problems.join("\n  ")}`
    );
  }

  const byDay = new Map<string, number>();
  for (const p of planned) byDay.set(isoDay(p.next), (byDay.get(isoDay(p.next)) ?? 0) + 1);
  const bySource = new Map<string, number>();
  for (const p of planned) bySource.set(p.probeSource, (bySource.get(p.probeSource) ?? 0) + 1);

  console.log(
    `[fix-canon-captured-at] planned ${planned.length} updates · target dates ${JSON.stringify(
      Object.fromEntries([...byDay].sort())
    )} · probe sources ${JSON.stringify(Object.fromEntries(bySource))}${apply ? "" : " (dry-run, no writes)"}`
  );
  for (const p of planned) {
    console.log(
      `  ${p.filename.padEnd(14)} ${(p.directory_path ?? "").padEnd(26)} ` +
        `${(p.captured_at ? p.captured_at.toISOString().slice(0, 16).replace("T", " ") : "NULL").padEnd(17)} -> ` +
        `${p.next.toISOString().slice(0, 19).replace("T", " ")}  [${p.probeSource}: ${p.probeValue}]`
    );
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    script: "scripts/fix-canon-captured-at.ts",
    rows: planned.map((p) => ({
      assetId: p.id,
      filename: p.filename,
      workspaceId: p.workspace_id,
      directoryPath: p.directory_path,
      storageKey: p.key,
      priorCapturedAt: p.captured_at ? p.captured_at.toISOString() : null,
      newCapturedAt: p.next.toISOString(),
      probeSource: p.probeSource,
      probeValue: p.probeValue,
      mtime: p.mtime,
    })),
  };
  fs.writeFileSync(undoPath, JSON.stringify(snapshot, null, 2));
  console.log(`[fix-canon-captured-at] undo snapshot written to ${undoPath} (${snapshot.rows.length} rows)`);

  if (!apply) {
    console.log("[fix-canon-captured-at] dry-run — re-run with --apply to write");
    await sql.end();
    return;
  }

  let written = 0;
  let skippedStale = 0;
  await sql.begin(async (tx) => {
    for (const p of planned) {
      // Compare-and-set on the prior value: a re-run is a no-op, and a
      // concurrent change loses instead of being overwritten.
      const res = p.captured_at
        ? await tx`
            UPDATE fonto.assets SET captured_at = ${p.next}
            WHERE id = ${p.id} AND captured_at = ${p.captured_at}`
        : await tx`
            UPDATE fonto.assets SET captured_at = ${p.next}
            WHERE id = ${p.id} AND captured_at IS NULL`;
      if (res.count === 1) written++;
      else skippedStale++;
    }
  });
  console.log(`[fix-canon-captured-at] applied: ${written} updated, ${skippedStale} skipped (prior value changed)`);

  const after = (await sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE captured_at IS NULL)::int AS still_null,
           count(*) FILTER (WHERE captured_at = '2026-01-01 12:00:00+00')::int AS still_fake
    FROM fonto.assets
    WHERE lifecycle_state = 'active'
      AND (filename ~ '^MVI_01(3[6-9]|4[01])[.]MP4$' OR filename ~ '^MVI_93[0-9]{2}[.]MOV$')
  `) as unknown as Array<{ n: number; still_null: number; still_fake: number }>;
  console.log(`[fix-canon-captured-at] verify: ${JSON.stringify(after[0])}`);

  const untouched = (await sql`
    SELECT count(*)::int AS n, min(created_at) AS min_created, max(created_at) AS max_created
    FROM fonto.assets WHERE id = ANY(${planned.map((p) => p.id)}::uuid[])
  `) as unknown as Array<{ n: number; min_created: Date; max_created: Date }>;
  console.log(`[fix-canon-captured-at] created_at unchanged window: ${JSON.stringify(untouched[0])}`);

  await sql.end();
}

main().catch((err) => {
  console.error("[fix-canon-captured-at] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
