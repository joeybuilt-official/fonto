#!/usr/bin/env bash
# Nightly R2 → offsite sync. Mirrors the Fonto bucket to the configured
# rclone remote. Uses `sync` (not `copy`) so deletions propagate;
# offsite cost is bounded by what lives in R2.
#
# Required env (same file as pg-dump.sh):
#   RCLONE_REMOTE         — e.g. "b2:fonto-backups"
#   R2_BUCKET             — source bucket name (e.g. "fonto-prod")
#   R2_RCLONE_REMOTE      — rclone remote pointing at R2
#                           (configure via `rclone config` w/ R2 token)
#
# rclone resumes mid-transfer; safe to retry. Idempotent.

set -euo pipefail

RCLONE_REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE must be set}"
R2_BUCKET="${R2_BUCKET:?R2_BUCKET must be set}"
R2_RCLONE_REMOTE="${R2_RCLONE_REMOTE:?R2_RCLONE_REMOTE must be set}"

echo "[r2-sync] $R2_RCLONE_REMOTE:$R2_BUCKET → $RCLONE_REMOTE/r2/"
rclone sync \
  "$R2_RCLONE_REMOTE:$R2_BUCKET" \
  "$RCLONE_REMOTE/r2/" \
  --progress \
  --transfers 8 \
  --checkers 16 \
  --fast-list

echo "[r2-sync] done"
