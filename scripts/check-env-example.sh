#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# check-env-example.sh — fails if `.env.example` has drifted behind the code.
#
# Why this exists: `.env.example` is the only place a self-hoster learns which
# variables exist. A variable the code reads but the template omits is invisible
# — the feature silently takes its default and nothing says a knob was there.
# The reverse (a variable in the template the code never reads) is how dead
# config accumulates.
#
#   bash scripts/check-env-example.sh
#
# Scope: `process.env.X` reads from tracked source files. Deliberately excluded,
# because they are supplied by the runtime or by a test harness rather than by
# an operator, and documenting them as deployable knobs would be misleading:
#   NODE_ENV, NEXT_RUNTIME   set by Node / Next.js itself
#   anything in e2e/         Playwright harness inputs
#   anything in *.test.ts    test fixtures
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

[ -f .env.example ] || { echo "check-env-example: no .env.example" >&2; exit 2; }

# Runtime/harness-provided or test-only variables: not operator knobs.
EXCLUDE_RE='^(NODE_ENV|NEXT_RUNTIME|BASE_URL|OUT|PLAYWRIGHT_[A-Z_]+|R2_(CONNECTION|SOCKET)_TIMEOUT_MS|__ADMIN)$'

code_vars="$(
  git ls-files -z \
    | xargs -0 grep -hoE 'process\.env\.[A-Z_][A-Z0-9_]{2,}' 2>/dev/null \
    | sed 's/process\.env\.//' \
    | sort -u \
    | grep -vE "$EXCLUDE_RE" || true
)"

doc_vars="$(
  grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z_][A-Z0-9_]*=' .env.example \
    | tr -d ' #' | tr -d '=' | sort -u
)"

missing="$(comm -23 <(echo "$code_vars") <(echo "$doc_vars"))"
# A documented variable the code never reads is allowed only if it is consumed
# by docker-compose.yml (compose-only knobs like POSTGRES_PASSWORD).
compose_vars=""
[ -f docker-compose.yml ] && compose_vars="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*' docker-compose.yml | sed 's/\${//' | sort -u)"
[ -f docker-compose.example.env ] && compose_vars="$(printf '%s\n%s\n' "$compose_vars" "$(grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z_][A-Z0-9_]*=' docker-compose.example.env | tr -d ' #=' | sort -u)" | sort -u)"

stale="$(comm -13 <(printf '%s\n%s\n' "$code_vars" "$compose_vars" | sort -u) <(echo "$doc_vars") | grep -vE "$EXCLUDE_RE" || true)"

status=0
if [ -n "$missing" ]; then
  echo "check-env-example: FAILED — $(echo "$missing" | wc -l | tr -d ' ') variable(s) read by code but absent from .env.example:" >&2
  echo "$missing" | sed 's/^/    /' >&2
  echo >&2
  echo "  Add them (with their real default, read off the source) or add to the" >&2
  echo "  EXCLUDE_RE above if they are runtime- or test-provided." >&2
  status=1
fi
if [ -n "$stale" ]; then
  echo "check-env-example: WARNING — $(echo "$stale" | wc -l | tr -d ' ') variable(s) documented but never read by code or compose:" >&2
  echo "$stale" | sed 's/^/    /' >&2
fi

if [ "$status" = "0" ]; then
  echo "check-env-example: OK — .env.example covers every variable the code reads ($(echo "$code_vars" | wc -l | tr -d ' ') code vars)."
fi
exit "$status"
