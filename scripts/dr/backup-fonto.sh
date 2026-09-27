#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# M14 / ADR 0058 — scheduled encrypted backup of the fonto schema.
#
# pg_dump (custom format) of ONLY the `$SCHEMA` schema inside the database named
# by $DB, gzipped and age-encrypted, written to $DEST. The dump includes
# __drizzle_migrations so a restore self-identifies its migration head. R2
# originals are already durable (dual-backend) and are NOT in this dump.
#
# Runs as an Linux NAS User Script (NOT raw /etc/cron.d — that is userless on
# Linux NAS). Schedule: daily 03:30. Fails closed + alerts on any error.
#
# Operator setup (one-time):
#   SECRETS=/your/infra/dir/fonto-backup   # pick your own secret dir
#   age-keygen -o "$SECRETS/key.txt"       # PRIVATE — move OFFLINE
#   grep 'public key' "$SECRETS/key.txt" | awk '{print $NF}' > "$SECRETS/recipient.txt"
#   echo '<ntfy/glitchtip webhook>' > "$SECRETS/alert_url"

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-postgres}"
SCHEMA="${SCHEMA:-fonto}"
# DB / DEST / SECRETS are REQUIRED — there are deliberately no committed
# defaults, because this repo is public and a baked default would name the
# maintainer's database and host paths. Validated below, after _alert is
# defined, so the failure message can reach the alert webhook.
DB="${DB:-}"
DEST="${DEST:-}"
SECRETS="${SECRETS:-}"
AGE_RECIPIENT_FILE="${AGE_RECIPIENT_FILE:-$SECRETS/recipient.txt}"
ALERT_URL_FILE="${ALERT_URL_FILE:-$SECRETS/alert_url}"

_alert() {
  local msg="$1"
  echo "[backup-fonto] ALERT: $msg" >&2
  if [ -f "$ALERT_URL_FILE" ]; then
    curl -fsS -m 15 -d "fonto backup FAILED: $msg" "$(cat "$ALERT_URL_FILE")" >/dev/null 2>&1 || true
  fi
}
trap '_alert "unexpected error at line $LINENO"' ERR

[ -n "$DB" ] || { _alert "DB is not set (the database holding the '$SCHEMA' schema)"; exit 1; }
[ -n "$DEST" ] || { _alert "DEST is not set (backup output directory)"; exit 1; }
[ -n "$SECRETS" ] || { _alert "SECRETS is not set (age key / recipient / alert_url directory)"; exit 1; }

# Host identity gate — fail closed before touching anything (wrong-host safety).
# Set EXPECT_HOSTNAME to the box this is allowed to run on; unset disables the
# gate (useful in CI / a fresh deploy).
if [ -n "${EXPECT_HOSTNAME:-}" ] && [ "$(hostname)" != "$EXPECT_HOSTNAME" ]; then
  _alert "refusing to run on host $(hostname) (expected $EXPECT_HOSTNAME)"
  exit 1
fi

[ -f "$AGE_RECIPIENT_FILE" ] || { _alert "missing age recipient file $AGE_RECIPIENT_FILE"; exit 1; }
command -v age >/dev/null 2>&1 || { _alert "age binary not installed on host"; exit 1; }
mkdir -p "$DEST"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/fonto-$TS.pgdump.gz.age"

# Connect as the container's superuser (docker exec defaults to OS user `root`,
# which is not a Postgres role) — mirrors verify-restore.sh.
PGUSER="$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER)"

# Stream dump -> gzip -> age. Never writes plaintext to disk. -Z0 because gzip
# does the compression (lets us pipe before encrypt).
docker exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -Fc -Z0 \
  --schema="$SCHEMA" --no-owner --no-privileges "$DB" \
  | gzip -9 \
  | age -R "$AGE_RECIPIENT_FILE" > "$OUT.tmp"

if [ ! -s "$OUT.tmp" ]; then
  rm -f "$OUT.tmp"
  _alert "empty dump artifact"
  exit 1
fi

mv "$OUT.tmp" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
SIZE="$(stat -c%s "$OUT")"
echo "$(date -u +%FT%TZ) OK $OUT ${SIZE}B" >> "$DEST/backup.log"
echo "[backup-fonto] wrote $OUT (${SIZE} bytes)"

# M15 closeout (ADR-0011) — off-site replication to Cloudflare R2.
# Uses the pre-configured rclone [r2] remote (same credentials as the app).
# Uploads the encrypted artifact + its sha256 to backups/fonto/ in the R2
# bucket so a NAS total-loss can be restored from cloud.
R2_REMOTE="${R2_REMOTE:-r2-fonto}"
R2_DEST="${R2_REMOTE}:fonto-assets/backups/fonto"
if command -v rclone >/dev/null 2>&1; then
  echo "[backup-fonto] uploading to R2..."
  if rclone copy "$OUT" "$R2_DEST/" --checksum --log-level ERROR 2>&1 && \
     rclone copy "$OUT.sha256" "$R2_DEST/" --checksum --log-level ERROR 2>&1; then
    R2_SIZE="$(rclone size "$R2_DEST/$(basename "$OUT")" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | grep -o '[0-9]*' || echo 0)"
    echo "$(date -u +%FT%TZ) R2_OK $(basename "$OUT") ${R2_SIZE}B" >> "$DEST/backup.log"
    echo "[backup-fonto] R2 upload OK"
  else
    _alert "R2 upload failed for $OUT"
  fi
else
  echo "[backup-fonto] rclone not installed — skipping R2 off-site upload"
fi

trap - ERR
