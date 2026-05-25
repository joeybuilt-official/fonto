#!/usr/bin/env bash
# Nightly Postgres backup. Dumps the `pushd` database (which holds the
# `fonto` schema) via pg_dump from inside the postgres
# container, gzips, then rclone-copies to the configured offsite remote.
#
# Required env (sourced from /data/appdata/appdata/ops/.env):
#   RCLONE_REMOTE       — e.g. "b2:fonto-backups"
#   PGUSER, PGPASSWORD  — DB creds (typically same as compose .env)
#
# Local artifacts kept 7 days in BACKUP_DIR; offsite keeps whatever the
# remote bucket lifecycle policy says.
#
# Exit 0 on full success; non-zero (and an Alertmanager push) on failure.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/data/appdata/appdata/backups/pg}"
RCLONE_REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE must be set}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
ts=$(date -u +%Y%m%d-%H%M%S)
file="$BACKUP_DIR/pushd-$ts.sql.gz"

echo "[pg-dump] dumping pushd → $file"
docker exec -e PGPASSWORD="$PGPASSWORD" postgres \
  pg_dump -U "$PGUSER" -Fp pushd | gzip -9 > "$file"

size=$(stat -c %s "$file")
echo "[pg-dump] dump complete ($((size / 1024 / 1024)) MB)"

echo "[pg-dump] rclone copy → $RCLONE_REMOTE"
rclone copy "$file" "$RCLONE_REMOTE/pg/" --progress

# Prune local backups older than retention.
find "$BACKUP_DIR" -name 'pushd-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
echo "[pg-dump] done"
