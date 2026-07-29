#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# M14 / ADR 0058 — GFS-lite retention for fonto backups.
# Keep: last 7 dailies, last 4 Sunday weeklies, last 3 first-of-month monthlies.
# Everything else (and its .sha256) is removed. Linux NAS User Script, daily 04:00.
#   --dry  print what would be removed, delete nothing.

set -euo pipefail

DEST="${DEST:-/data/backups/fonto}"
DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

[ "$(hostname)" = "NAS" ] || { echo "refusing to run on $(hostname)" >&2; exit 1; }
cd "$DEST" 2>/dev/null || { echo "no backup dir $DEST"; exit 0; }

# Artifacts are fonto-YYYYMMDDThhmmssZ.pgdump.gz.age — lexical sort == chrono.
mapfile -t ALL < <(ls -1 fonto-*.pgdump.gz.age 2>/dev/null | sort)
[ "${#ALL[@]}" -eq 0 ] && { echo "no backups"; exit 0; }

declare -A KEEP
# last 7 dailies
for f in $(printf '%s\n' "${ALL[@]}" | tail -7); do KEEP["$f"]=1; done
# last 4 Sunday weeklies + last 3 first-of-month monthlies
for f in "${ALL[@]}"; do
  d="${f#fonto-}"; d="${d%%T*}"                 # YYYYMMDD
  dow="$(date -u -d "$d" +%u 2>/dev/null || echo 0)"   # 7 = Sunday
  dom="${d:6:2}"
  [ "$dow" = "7" ] && WEEK+=("$f")
  [ "$dom" = "01" ] && MONTH+=("$f")
done
for f in $(printf '%s\n' "${WEEK[@]:-}" | sort | tail -4); do [ -n "$f" ] && KEEP["$f"]=1; done
for f in $(printf '%s\n' "${MONTH[@]:-}" | sort | tail -3); do [ -n "$f" ] && KEEP["$f"]=1; done

for f in "${ALL[@]}"; do
  if [ -z "${KEEP[$f]:-}" ]; then
    if [ "$DRY" = "1" ]; then
      echo "would remove $f"
    else
      rm -f "$f" "$f.sha256"
      echo "$(date -u +%FT%TZ) PRUNED $f" >> "$DEST/backup.log"
      echo "removed $f"
    fi
  fi
done
