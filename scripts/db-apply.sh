#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# db-apply.sh — the SUPPORTED way to create/upgrade a Fonto database schema.
#
#   pnpm db:setup            # == bash scripts/db-apply.sh
#   DATABASE_URL=... bash scripts/db-apply.sh
#   bash scripts/db-apply.sh --adopt      # mark everything applied, run nothing
#   bash scripts/db-apply.sh --dry-run    # print the plan, touch nothing
#
# WHY NOT `pnpm db:migrate` (drizzle-kit migrate)
# -----------------------------------------------
# drizzle-kit's migrator cannot work on this repository, for three independent
# reasons — each verified against drizzle-orm 0.45 / drizzle-kit 0.31 sources:
#
#   1. NO JOURNAL. `drizzle-orm/migrator.js:readMigrationFiles()` throws
#      "Can't find meta/_journal.json file" when `drizzle/meta/_journal.json`
#      is absent. This repo has 62 hand-named SQL files under
#      `drizzle/migrations/` and no `drizzle/meta/` at all, so the documented
#      `pnpm db:migrate` applies NOTHING on a fresh clone.
#
#   2. NO BASELINE. `drizzle/migrations/` starts at 0001_share_links.sql, and
#      0002 immediately runs `ALTER TABLE fonto.assets`. No file in the series
#      ever CREATEs `fonto.assets` (or workspaces / collections / tags /
#      asset_tags / upload_sessions / smart_collections / projects /
#      correspondents / document_types / collection_assets). Those eleven
#      tables were created out-of-band before the numbered series began. A
#      journal would not fix this — see `drizzle/baseline/`.
#
#   3. ONE TRANSACTION, ALWAYS. `drizzle-orm/pg-core/dialect.js:migrate()`
#      wraps EVERY pending migration in a single `session.transaction(...)`.
#      Migrations 0037 and 0058 run `CREATE INDEX CONCURRENTLY`, which Postgres
#      refuses inside a transaction block ("CREATE INDEX CONCURRENTLY cannot run
#      inside a transaction block"). So even with a journal and a baseline,
#      drizzle-kit migrate would hard-fail on this series.
#
# We deliberately did NOT generate `drizzle/meta/_journal.json`. Besides
# reasons 2 and 3 above, drizzle's skip test is
# `Number(lastDbMigration.created_at) < migration.folderMillis` — it compares
# journal timestamps against rows already in the tracking table. Any synthetic
# `when` values we invent would be unrelated to the rows live installs already
# hold, so the migrator would either re-apply migrations that are NOT
# idempotent (0026/0029/0030/0031 use unguarded `ALTER TABLE ... ADD COLUMN`;
# 0027/0028/0036 use unguarded `CREATE TABLE`) or silently skip real ones.
# Re-applying against production metadata is the failure mode we refuse to
# risk. `db:migrate` is left in package.json only because AGENTS.md forbids
# `db:push`; treat it as unsupported until the series is re-baselined by
# drizzle-kit going forward.
#
# TRANSACTION POLICY
# ------------------
# Each file is applied with `psql -v ON_ERROR_STOP=1 -f <file>` and NO
# surrounding transaction, so every statement autocommits. That is what makes
# `CREATE INDEX CONCURRENTLY` (0037, 0058) and `CREATE EXTENSION` (0017, 0021)
# legal. The trade-off — a mid-file failure leaves the earlier statements in
# that file applied — is accepted deliberately: the series is written to be
# re-runnable, the log records only successfully-completed files, and a failed
# file is therefore retried in full on the next run.
#
# IDEMPOTENCY
# -----------
# Applied files are recorded in `fonto.__db_apply_log` (filename primary key),
# a SEPARATE table from `fonto.__drizzle_migrations`. We do not write to
# drizzle's own table: its `created_at` column is a journal timestamp consumed
# by the migrator's skip test above, and polluting it is exactly the
# double-apply hazard described. The log also stores each file's sha256 and
# fails loudly if a recorded file's contents later changed on disk.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_DIR="$REPO_ROOT/drizzle/baseline"
MIGRATIONS_DIR="$REPO_ROOT/drizzle/migrations"
LOG_SCHEMA="${FONTO_MIGRATION_SCHEMA:-fonto}"
LOG_TABLE="__db_apply_log"

ADOPT=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --adopt) ADOPT=1 ;;
    --dry-run|--plan) DRY_RUN=1 ;;
    -h|--help) sed -n '5,90p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "db-apply: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "db-apply: ERROR: $*" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────────
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set. Export it (see .env.example) — e.g.
  export DATABASE_URL=postgresql://fonto:***@localhost:5432/fonto"

PSQL_BIN="${PSQL_BIN:-$(command -v psql 2>/dev/null || true)}"
[ -n "$PSQL_BIN" ] || die "psql not found on PATH. Install a Postgres 16 client, or set PSQL_BIN=/path/to/psql.
  (The docker-compose 'migrate' service ships one; on a bare host: apt-get install postgresql-client)"

[ -d "$MIGRATIONS_DIR" ] || die "no migrations directory at $MIGRATIONS_DIR"

psql_run() {
  # -X: ignore ~/.psqlrc (a stray \set can break ON_ERROR_STOP semantics)
  # -q: quiet; our own log lines are the signal
  "$PSQL_BIN" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
}

psql_scalar() { psql_run -tA -c "$1"; }

echo "db-apply: target ${DATABASE_URL%%@*}@… (psql: $PSQL_BIN)"

# ── Collect files in strict filename order ──────────────────────────────────
# Baselines first (0000_*), then the numbered series. `sort` on the full path
# gives a deterministic order even for the duplicated 0045 slot
# (0045_grid_perf_index.sql sorts before 0045_intelligence_inference.sql).
FILE_LIST="$(mktemp)"
trap 'rm -f "$FILE_LIST"' EXIT
{
  if [ -d "$BASELINE_DIR" ]; then
    find "$BASELINE_DIR" -maxdepth 1 -name '*.sql' -type f
  fi
  find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f
} > "$FILE_LIST"
mapfile -t ALL_FILES < <(sort "$FILE_LIST")
[ "${#ALL_FILES[@]}" -gt 0 ] || die "found no .sql files to apply"

# ── Dry run ─────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo "db-apply: DRY RUN — ${#ALL_FILES[@]} file(s) in order:"
  for f in "${ALL_FILES[@]}"; do echo "  $(basename "$f")"; done
  echo "db-apply: (pending/already-applied status needs a DB connection; not checked in dry-run)"
  exit 0
fi

# ── Ensure schemas + log table ──────────────────────────────────────────────
# `auth` holds Better Auth's tables (lib/auth.ts sets search_path=auth);
# `fonto` holds the app schema. Both baselines are IF NOT EXISTS-guarded, but
# the schemas must exist before the log table can be created.
psql_run -c "CREATE SCHEMA IF NOT EXISTS fonto;" \
         -c "CREATE SCHEMA IF NOT EXISTS auth;"

psql_run <<SQL
CREATE TABLE IF NOT EXISTS "$LOG_SCHEMA"."$LOG_TABLE" (
  filename   text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

# ── Live-install guard ──────────────────────────────────────────────────────
# An EXISTING database already migrated the old way has rows in
# `fonto.__drizzle_migrations` but none in our own log table. Replaying the
# series against it would hard-fail (0026/0029/0030/0031 use unguarded
# `ALTER TABLE … ADD COLUMN`; 0027/0028/0036 use unguarded `CREATE TABLE`) and,
# worse, a partially-applied file would leave the schema in a state nobody has
# reasoned about. Detect that and require an explicit, non-executing --adopt.
LEGACY_ROWS="$(psql_run -tA -c "
  SELECT count(*) FROM information_schema.tables t
   WHERE t.table_schema = '$LOG_SCHEMA' AND t.table_name = '__drizzle_migrations';" 2>/dev/null || echo 0)"
# --adopt IS the escape hatch this guard points at, so it must not be blocked by
# it. (Adopt executes no SQL — it only records current filenames + hashes.)
if [ "$ADOPT" = "0" ] && [ "${LEGACY_ROWS:-0}" != "0" ]; then
  OUR_ROWS="$(psql_run -tA -c "
    SELECT count(*) FROM \"$LOG_SCHEMA\".\"$LOG_TABLE\";" 2>/dev/null || echo 0)"
  if [ "${OUR_ROWS:-0}" = "0" ]; then
    die "this database already has '$LOG_SCHEMA.__drizzle_migrations' (a live or
     previously-migrated install) but no '$LOG_SCHEMA.$LOG_TABLE' rows, so this
     script cannot tell which of the ${#ALL_FILES[@]} files are already applied.

     Refusing to guess — replaying the series here would fail on the
     non-idempotent files (0026, 0027, 0028, 0029, 0030, 0031, 0036).

     If this database IS fully up to date with drizzle/migrations/, adopt the
     current state WITHOUT executing any SQL:

         bash scripts/db-apply.sh --adopt

     Then verify the head really matches:

         SELECT max(hash) FROM $LOG_SCHEMA.__drizzle_migrations;
         ls drizzle/migrations | tail -1

     Point this script at an EMPTY database instead if you meant to build a
     fresh one from scratch."
  fi
fi


sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else die "need sha256sum or shasum to fingerprint migrations"; fi
}

# --adopt is for a database that ALREADY has the schema (migrated out-of-band
# before this script existed). It records state and executes nothing, so running
# it against an empty database would stamp all ${#ALL_FILES[@]} files as applied
# on a schema that does not exist — a green log and a broken install, with no
# later run able to repair it (every file would be skipped as already-applied).
# Require evidence the schema is really there first.
if [ "$ADOPT" = "1" ]; then
  present="$(psql_run -tA -c "
    SELECT count(*) FROM information_schema.tables
     WHERE (table_schema = '$LOG_SCHEMA' AND table_name = 'assets')
        OR (table_schema = 'auth'          AND table_name = 'user');" 2>/dev/null || echo 0)"
  if [ "${present:-0}" = "0" ]; then
    die "--adopt was requested but this database has neither '$LOG_SCHEMA.assets'
     nor 'auth.\"user\"' — it does not look migrated at all, so there is no
     state to adopt. Adopting here would mark all ${#ALL_FILES[@]} files as applied
     against an empty schema, and every later run would skip them, leaving a
     database that reports success and cannot serve a request.

     If this really is a fresh database, run WITHOUT --adopt to create it:
         bash scripts/db-apply.sh
     If the schema lives under a different schema name, set APP_SCHEMA_NAMESPACE
     (or fix the target DATABASE_URL) and retry."
  fi
  echo "db-apply: --adopt preflight OK — found existing '$LOG_SCHEMA.assets' / auth." >&2
fi

# ── Apply ───────────────────────────────────────────────────────────────────
applied=0; skipped=0; failed=""
for f in "${ALL_FILES[@]}"; do
  name="$(basename "$f")"
  want="$(sha256_of "$f")"

  row="$(psql_run -tA -c "SELECT sha256 FROM \"$LOG_SCHEMA\".\"$LOG_TABLE\" WHERE filename = '$name';")"

  if [ -n "$row" ]; then
    if [ "$row" != "$want" ]; then
      die "$name was already applied but its contents changed on disk
       recorded sha256: $row
       current  sha256: $want
     A migration file must be immutable once applied. If this edit is
     intentional (e.g. you are repairing a dev database), delete the row:
       DELETE FROM $LOG_SCHEMA.$LOG_TABLE WHERE filename = '$name';
     For a live database, ship a NEW migration instead."
    fi
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$ADOPT" = "1" ]; then
    echo "db-apply: ADOPT  $name (marked applied, not executed)"
    psql_run -c "INSERT INTO \"$LOG_SCHEMA\".\"$LOG_TABLE\" (filename, sha256) VALUES ('$name', '$want');"
    applied=$((applied + 1))
    continue
  fi

  echo "db-apply: APPLY  $name"
  # No wrapping transaction — see TRANSACTION POLICY above.
  if ! psql_run -f "$f"; then
    failed="$name"
    break
  fi
  psql_run -c "INSERT INTO \"$LOG_SCHEMA\".\"$LOG_TABLE\" (filename, sha256) VALUES ('$name', '$want');"
  applied=$((applied + 1))
done

if [ -n "$failed" ]; then
  die "migration '$failed' FAILED. The log table was NOT updated for it, so a
     re-run retries that file from its first statement; every file before it is
     committed and will be skipped.

     CAVEAT: because files are applied WITHOUT a wrapping transaction (required
     for CREATE INDEX CONCURRENTLY in 0037/0058), a mid-file failure leaves that
     file's earlier statements applied. Most files in the series are
     IF NOT EXISTS-guarded and therefore retry cleanly; these are NOT and will
     need manual repair before a retry can succeed:
       0026_video_metadata      unguarded ALTER TABLE … ADD COLUMN
       0027_comments_activity   unguarded CREATE TABLE
       0028_extended_roles      unguarded CREATE TABLE + ALTER TABLE
       0029_hls_ladder_sprite   unguarded ALTER TABLE … ADD COLUMN
       0030_workspace_quotas    unguarded ALTER TABLE … ADD COLUMN
       0031_document_page_count unguarded ALTER TABLE … ADD COLUMN
       0036_person_groups       unguarded CREATE TABLE
     Repair = drop/re-add the partially-applied objects, or drop the database
     and re-run from scratch (safe before you have real data)."
fi

echo "db-apply: done — $applied applied, $skipped already up to date, ${#ALL_FILES[@]} total"
if [ "$ADOPT" = "1" ]; then
  echo "db-apply: NOTE — --adopt only records state; it never executed SQL."
  echo "db-apply:        Verify the schema actually matches (see script header)."
fi
