#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# M14 / ADR 0058 — scheduled encrypted backup of the fonto schema.
#
# pg_dump (custom format) of ONLY the `fonto` schema inside the shared `pushd`
# DB, gzipped and age-encrypted, written to the NAS array. The dump includes
# __drizzle_migrations so a restore self-identifies its migration head. R2
# originals are already durable (dual-backend) and are NOT in this dump.
#
# Runs as an Linux NAS User Script (NOT raw /etc/cron.d — that is userless on
# Linux NAS). Schedule: daily 03:30. Fails closed + alerts on any error.
#
# Operator setup (one-time):
#   age-keygen -o /data/_secrets/fonto-backup/key.txt   # PRIVATE — move OFFLINE
#   grep 'public key' /data/_secrets/fonto-backup/key.txt | awk '{print $NF}' \
#     > /data/_secrets/fonto-backup/recipient.txt        # public recipient stays on-box
#   echo '<ntfy/glitchtip webhook>' > /data/_secrets/fonto-backup/alert_url

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-postgres}"
DB="${DB:-pushd}"
SCHEMA="${SCHEMA:-fonto}"
DEST="${DEST:-/data/backups/fonto}"
SECRETS="${SECRETS:-/data/_secrets/fonto-backup}"
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

# NAS identity gate — fail closed before touching anything (wrong-host safety).
if [ "$(hostname)" != "NAS" ]; then
  _alert "refusing to run on host $(hostname) (expected NAS)"
  exit 1
fi

[ -f "$AGE_RECIPIENT_FILE" ] || { _alert "missing age recipient file $AGE_RECIPIENT_FILE"; exit 1; }
command -v age >/dev/null 2>&1 || { _alert "age binary not installed on host"; exit 1; }
mkdir -p "$DEST"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/fonto-$TS.pgdump.gz.age"

# Stream dump -> gzip -> age. Never writes plaintext to disk. -Z0 because gzip
# does the compression (lets us pipe before encrypt).
docker exec "$PG_CONTAINER" pg_dump -Fc -Z0 \
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
trap - ERR
