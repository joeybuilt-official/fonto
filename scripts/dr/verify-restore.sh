#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# M14 / ADR 0058 — restore DRILL. Decrypts the latest backup and restores it
# into an ISOLATED throwaway DATABASE (never the live `pushd`/`fonto`), asserts
# the data is present, then drops the throwaway DB. This is the gate that flips
# ADR 0058 Proposed → Accepted: run once and confirm PASS.
#
#   verify-restore.sh <age-private-key> [artifact.pgdump.gz.age]
#
# The private key is OFFLINE — pass its path explicitly.

set -euo pipefail

KEY="${1:?usage: verify-restore.sh <age-private-key> [artifact]}"
DEST="${DEST:-/data/backups/fonto}"
PG_CONTAINER="${PG_CONTAINER:-postgres}"
TESTDB="fonto_restore_test"
ART="${2:-$(ls -1 "$DEST"/fonto-*.pgdump.gz.age 2>/dev/null | sort | tail -1)}"

[ "$(hostname)" = "NAS" ] || { echo "run on the host" >&2; exit 1; }
[ -f "$KEY" ] || { echo "missing private key $KEY" >&2; exit 1; }
[ -n "$ART" ] && [ -f "$ART" ] || { echo "no artifact found" >&2; exit 1; }
echo "[verify] artifact: $ART"

if [ -f "$ART.sha256" ]; then
  (cd "$(dirname "$ART")" && sha256sum -c "$(basename "$ART").sha256") \
    || { echo "sha256 mismatch" >&2; exit 1; }
fi

PGUSER="$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER)"
TMP="$(mktemp /tmp/fonto-restore.XXXXXX.pgdump)"
cleanup() {
  rm -f "$TMP"
  docker exec "$PG_CONTAINER" sh -lc "rm -f /tmp/restore.pgdump" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d postgres \
    -c "DROP DATABASE IF EXISTS $TESTDB;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

age -d -i "$KEY" "$ART" | gunzip > "$TMP"
echo "[verify] decrypted $(stat -c%s "$TMP") bytes"

# Isolated throwaway DB — the dump's `fonto` schema restores cleanly here with
# zero possibility of touching the live pushd database.
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $TESTDB;" -c "CREATE DATABASE $TESTDB;"
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$TESTDB" -c "CREATE SCHEMA IF NOT EXISTS fonto;"
docker cp "$TMP" "$PG_CONTAINER:/tmp/restore.pgdump"
docker exec "$PG_CONTAINER" sh -lc \
  "pg_restore --no-owner --no-privileges -d '$TESTDB' /tmp/restore.pgdump 2>&1 | tail -3 || true"

ASSETS="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$TESTDB" -tAc \
  "SELECT count(*) FROM fonto.assets;" 2>/dev/null || echo 0)"
HEAD="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$TESTDB" -tAc \
  "SELECT max(hash) IS NOT NULL FROM fonto.__drizzle_migrations;" 2>/dev/null || echo f)"

echo "[verify] restored fonto.assets rows: $ASSETS ; migrations present: $HEAD"
if [ "${ASSETS:-0}" -gt 0 ]; then
  echo "[verify] PASS"
  exit 0
fi
echo "[verify] FAIL — no rows restored" >&2
exit 1
