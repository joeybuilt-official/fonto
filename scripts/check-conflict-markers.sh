#!/usr/bin/env sh
# check-conflict-markers.sh — no commit may carry an unresolved merge conflict.
#
# WHY THIS EXISTS
# ---------------
# A conflict marker is the one corrupt state a generated file can be in that nothing else caught:
#
#   * `sync-agents.sh --check` compares only ITS OWN generated block. A `<<<<<<< HEAD` on the line
#     above the block, or a duplicated marker pair, is invisible to it. REPRODUCED: a file carrying a
#     conflict marker AND a doubled, empty PANOPLY:RULES block passed `--check` clean.
#   * The other gates read structure (docs spine, plan home, spec presence, rule anchors) — none read
#     the bytes for a marker.
#   * It reached `main` in this repo exactly that way, from a merge conflict resolved by hand.
#     AGENTS.md shipped both halves of a conflict as if they were the document, and every gate passed.
#
# An agent reading a file that still contains `<<<<<<< HEAD` gets two contradictory instruction sets
# with no signal that anything is wrong. There is no legitimate case for a marker in a committed file,
# which is what makes this safely absolute.
#
# PROVENANCE, AND WHY THIS SHAPE
# ------------------------------
# a pilot repo solved this first, as a sweep inside its own `check-docs.sh`; the kit never absorbed it.
# This is that design, promoted to its own gate so it can be adopted on its own terms:
#
#   * `git grep -nE` scans the whole tracked tree in ONE pass — measured 8 ms against 431 ms for a
#     file-by-file loop over the same tree (54x). The pattern is a regex for the same reason the
#     upstream one is: this script then cannot match ITSELF, which a literal marker would.
#   * The upstream version's one real defect is fixed here: `git grep` exits 1 both for "no match" and
#     for some errors, so a search that never happened would read as a clean tree. A fatal exit (>=2)
#     now refuses instead of passing.
#
#   sh scripts/check-conflict-markers.sh              # scan the tracked tree
#   sh scripts/check-conflict-markers.sh --since REF  # scan files touched by REF..HEAD
#   CONFLICTS_OFF=1                                   # deliberate exception (say so out loud)
#
# POSIX sh, no runtime deps. Exit 0 clean, 1 on a finding, 2 if it cannot determine an answer.
set -u

[ "${CONFLICTS_OFF:-0}" = "1" ] && { echo "check-conflict-markers: disabled (CONFLICTS_OFF=1)"; exit 0; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# Written as a regex so this script cannot match itself. `=======` is included, and that is safe here
# because it is anchored as a line of exactly seven equals signs — what a Markdown heading underline
# looks like. It is reported in a SEPARATE, non-failing bucket: an always-red gate is the failure mode
# the kit's own doctrine warns against, so the ambiguous class never fails the build.
PATTERN='^(<{7}( |$)|={7}$|>{7}( |$))'

MODE="tree"
SINCE=""
case "${1:-}" in
  --since)
    MODE="since"
    SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-conflict-markers: --since needs a base ref — set CONFLICTS_OFF=1 for a deliberate skip." >&2
      exit 2
    fi
    ;;
  "") ;;
  *) echo "check-conflict-markers: unknown argument '$1'" >&2; exit 2 ;;
esac

ERR="$(mktemp)" || exit 2
trap 'rm -f "$ERR"' EXIT INT TERM

# --- the search -----------------------------------------------------------------
# A missing base must REFUSE rather than search nothing: an empty path list reports OK and is
# indistinguishable from a clean tree — the failure mode check-spec.sh already documents.
if [ "$MODE" = "since" ]; then
  if ! git rev-parse -q --verify "${SINCE}^{commit}" >/dev/null 2>&1; then
    echo "check-conflict-markers: diff base '$SINCE' does not resolve in this checkout (shallow clone" >&2
    echo "  or wrong ref). Pass the PR base SHA, or set CONFLICTS_OFF=1 for a deliberate skip." >&2
    exit 2
  fi
  # Only paths in the range, so an unrelated older marker is not re-flagged against every change.
  PATHS="$(for sha in $(git rev-list "$SINCE"..HEAD 2>/dev/null); do
             git show --name-only --format= "$sha" 2>/dev/null
           done | sort -u | tr '\n' ' ')"
  [ -n "$PATHS" ] || PATHS="."
else
  PATHS="."
fi

# `$PATHS` is deliberately unquoted: it is a space-separated list of pathspecs, so word splitting is
# the intent. Quoting it would pass one path containing spaces and silently search nothing.
# shellcheck disable=SC2086
hits="$(git grep -nE "$PATTERN" -- $PATHS 2>"$ERR")"
rc=$?
# git grep: 0 = found, 1 = none found, >=2 = the search itself failed. Keeping a failed SEARCH distinct
# from a clean tree is the whole point — otherwise "nothing was searched" reads as a pass.
if [ "$rc" -ge 2 ]; then
  echo "check-conflict-markers: the search failed (git grep exit $rc) — refusing to report a clean tree." >&2
  sed 's/^/  /' "$ERR" >&2 2>/dev/null
  exit 2
fi

if [ -z "$hits" ]; then
  echo "check-conflict-markers: OK (no unresolved conflict markers)"
  exit 0
fi

# Split the decisive markers from the ambiguous `=======` line so only the decisive class fails.
decisive="$(printf '%s\n' "$hits" | grep -E ':[0-9]+:(<{7}( |$)|>{7}( |$))' || true)"
ambiguous="$(printf '%s\n' "$hits" | grep -E ':[0-9]+:={7}$' || true)"

if [ -n "$decisive" ]; then
  echo "check-conflict-markers: unresolved conflict markers in tracked files:" >&2
  printf '%s\n' "$decisive" | head -10 | sed 's/^/  /' >&2
  echo "" >&2
  echo "  A marker is never intentional in a committed file. It reaches main when a conflict is resolved" >&2
  echo "  by hand and the resolution keeps both sides — as happened to AGENTS.md in this repo." >&2
  echo "  Resolve it, or set CONFLICTS_OFF=1 as a stated exception." >&2
  exit 1
fi

if [ -n "$ambiguous" ]; then
  # Deliberately does NOT fail: a Markdown heading underline is legal. Surfaced so a real marker is not
  # hidden by its own ambiguity.
  echo "check-conflict-markers: note — lines of exactly seven '=' found (legal in Markdown, but a" >&2
  echo "  merge marker looks identical). Check these are heading underlines:" >&2
  printf '%s\n' "$ambiguous" | head -5 | sed 's/^/  /' >&2
fi

echo "check-conflict-markers: OK (no unresolved conflict markers)"
exit 0
