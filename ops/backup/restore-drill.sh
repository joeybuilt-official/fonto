#!/usr/bin/env bash
# Monthly restore drill. Pulls the latest dump from offsite, loads it
# into a throwaway postgres-drill sidecar container, runs a handful of
# smoke queries, then tears down. Failure → non-zero exit + Alertmanager
# notification via Pushgateway.
#
# Required env:
#   RCLONE_REMOTE          — same as backup scripts
#   PGDATABASE             — the database the dumps are of (same as pg-dump.sh)
#   PGPASSWORD             — superuser password for the drill container
#                            (separate from prod — does NOT need to match)
#   PUSHGATEWAY_URL        — optional; if set, pushes drill-status metric
#
# The drill container uses the same postgres image + version as prod
# (verified via `docker inspect`). Schema is recreated by replay of the
# dump; we do NOT mount any persistent volume — fully ephemeral.

set -euo pipefail

RCLONE_REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE must be set}"
PGDATABASE="${PGDATABASE:?PGDATABASE must be set (the database the dumps are of)}"
PGPASSWORD="${PGPASSWORD:?PGPASSWORD must be set}"
DRILL_NAME="${DRILL_NAME:-fonto-restore-drill}"
DRILL_VOL_TMP="$(mktemp -d)"

cleanup() {
  docker rm -f "$DRILL_NAME" >/dev/null 2>&1 || true
  rm -rf "$DRILL_VOL_TMP"
}
trap cleanup EXIT

# Find the prod postgres image to match versions exactly.
PG_IMAGE=$(docker inspect postgres --format '{{.Config.Image}}')
echo "[drill] using image $PG_IMAGE"

# Pull the most-recent dump from offsite.
echo "[drill] fetching latest dump from $RCLONE_REMOTE/pg/"
latest=$(rclone lsf "$RCLONE_REMOTE/pg/" | grep -E "^${PGDATABASE}-.*\\.sql\\.gz$" | sort | tail -1)
if [[ -z "$latest" ]]; then
  echo "[drill] FAIL: no dump found at $RCLONE_REMOTE/pg/"
  exit 2
fi
rclone copy "$RCLONE_REMOTE/pg/$latest" "$DRILL_VOL_TMP/"
dump_path="$DRILL_VOL_TMP/$latest"
echo "[drill] dump: $latest ($(stat -c %s "$dump_path") bytes)"

# Boot the drill container.
echo "[drill] starting drill container"
docker run -d --rm \
  --name "$DRILL_NAME" \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB="$PGDATABASE" \
  "$PG_IMAGE" >/dev/null

# Wait until ready (max 30s).
for i in {1..30}; do
  if docker exec "$DRILL_NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[drill] loading dump"
gunzip -c "$dump_path" | docker exec -i "$DRILL_NAME" \
  psql -U postgres -d "$PGDATABASE" -v ON_ERROR_STOP=1 >/dev/null

# Smoke queries. Each MUST return > 0 rows (an empty load is a silent failure).
echo "[drill] smoke queries"
checks=(
  "SELECT count(*) FROM fonto.assets;"
  "SELECT count(*) FROM fonto.workspaces;"
  "SELECT count(*) FROM fonto.workspace_members;"
)
for q in "${checks[@]}"; do
  n=$(docker exec "$DRILL_NAME" psql -U postgres -d "$PGDATABASE" -tAc "$q")
  if [[ "$n" -lt 1 ]]; then
    echo "[drill] FAIL: query returned 0 rows: $q"
    exit 3
  fi
  echo "[drill]   $q → $n rows"
done

# Optional push to Alertmanager via Pushgateway so the dashboard knows
# the drill succeeded today.
if [[ -n "${PUSHGATEWAY_URL:-}" ]]; then
  cat <<EOF | curl --data-binary @- "$PUSHGATEWAY_URL/metrics/job/fonto-restore-drill"
# TYPE fonto_restore_drill_last_success_timestamp gauge
fonto_restore_drill_last_success_timestamp $(date +%s)
EOF
fi

echo "[drill] PASS"
