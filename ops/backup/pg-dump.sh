#!/usr/bin/env bash
# Nightly Postgres backup. Dumps the database named by $PGDATABASE (which holds the
# `fonto` schema) via pg_dump from inside the postgres
# container, gzips, then rclone-copies to the configured offsite remote.
#
# Required env (sourced from your ops env file, e.g. <host-path>/ops/.env):
#   RCLONE_REMOTE       — e.g. "b2:fonto-backups"
#   PGUSER, PGPASSWORD  — DB creds (typically same as compose .env)
#
# Local artifacts kept 7 days in BACKUP_DIR; offsite keeps whatever the
# remote bucket lifecycle policy says.
#
# Exit 0 on full success; non-zero (and an Alertmanager push) on failure.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/lib/fonto-backups/pg}"   # override per host
RCLONE_REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE must be set}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
ts=$(date -u +%Y%m%d-%H%M%S)
file="$BACKUP_DIR/${PGDATABASE:?PGDATABASE is required}-$ts.sql.gz"

echo "[pg-dump] dumping $PGDATABASE → $file"
docker exec -e PGPASSWORD="$PGPASSWORD" postgres \
  pg_dump -U "$PGUSER" -Fp "$PGDATABASE" | gzip -9 > "$file"

size=$(stat -c %s "$file")
echo "[pg-dump] dump complete ($((size / 1024 / 1024)) MB)"

echo "[pg-dump] rclone copy → $RCLONE_REMOTE"
rclone copy "$file" "$RCLONE_REMOTE/pg/" --progress

# Prune local backups older than retention.
find "$BACKUP_DIR" -name "${PGDATABASE}-*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
echo "[pg-dump] done"
