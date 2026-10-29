#!/usr/bin/env sh
# check-plan-home.sh — the plan-home gate: one canonical plan doc per project, and only one.
#
# Enforces the plan-home rule (.agents/rules/workflow.md → Planning Workflow) mechanically. The
# convention has existed since the kit shipped; what it never had was a check, and an advisory rule
# drifts: plan docs accumulate at the repo root (PLAN.md, ROADMAP.md, <feature>-plan.md,
# PHASED-PLAN.md) until nobody can tell which one is authoritative and an agent picking the project
# up reads the wrong one.
#
# The rule: a plan is a row in docs/agents/roadmap.md. Detail lives at
# docs/agents/<area>/<feature>/plan.md, linked from that row. Nothing plan-shaped lives anywhere
# else — not at the repo root, not flat in docs/agents/, not in a top-level <name>-plan/ directory.
#
#   sh scripts/check-plan-home.sh            # check tracked files (CI context)
#   sh scripts/check-plan-home.sh --staged   # check staged additions only (pre-commit context)
#
# Config (all optional, space-separated globs unless noted):
#   PLAN_HOME_ALLOW   extra paths to exempt, e.g. "docs/adr/*.md legacy/PLAN.md"
#   PLAN_HOME_OFF=1   disable entirely (adopting repo with a large backlog; fix then re-enable)
#
# The gate enforces LOCATION, not CONTENT: a roadmap row saying "TBD" passes. Location is what an
# automation can honestly check; whether the plan is any good is a review problem.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${PLAN_HOME_OFF:-0}" = "1" ] && { echo "check-plan-home: disabled (PLAN_HOME_OFF=1)"; exit 0; }

CANON="docs/agents/roadmap.md"

# --- collect candidate files -------------------------------------------------
# Tracked files by default; staged ADDITIONS in --staged mode (renames/edits of an already-known
# stray must not block an unrelated commit — only newly introduced strays do).
if [ "${1:-}" = "--staged" ]; then
  MODE="staged change"
  FILES="$(git diff --cached --name-only --diff-filter=A 2>/dev/null || true)"
else
  MODE="tracked file"
  FILES="$(git ls-files 2>/dev/null || true)"
fi

# --- is this path plan-shaped, and is it outside the canonical home? ---------
# Plan-shaped: a markdown file whose basename reads as a plan/roadmap artifact.
is_plan_shaped() {
  base="$(basename "$1" | tr '[:upper:]' '[:lower:]')"
  # A leading dot does not make a plan doc any less of a competing plan doc —
  # `.plan-specs.md` was found in the wild holding live, blocker-carrying work.
  base="${base#.}"
  case "$base" in
    *.md) ;;
    *) return 1;;
  esac
  case "$base" in
    plan.md|roadmap.md|plans.md|*-plan.md|plan-*.md|*-roadmap.md|roadmap-*.md)
      return 0;;
    *) return 1;;
  esac
}

# Allowed homes: the canonical roadmap, the queue, per-feature plans inside an area folder, the
# templates, and the archive. Everything else plan-shaped is a stray.
is_allowed() {
  case "$1" in
    "$CANON") return 0;;
    docs/agents/in-progress.md) return 0;;
    docs/agents/_templates/*) return 0;;
    docs/agents/reports/*) return 0;;
    # docs/agents/<area>/<feature>/plan.md — and anything under an area's completed/ archive.
    docs/agents/*/*/plan.md) return 0;;
    docs/agents/*/completed/*) return 0;;
    # Vendored / generated trees are not ours to police.
    node_modules/*|vendor/*|.agents-kit-tmp/*|*/node_modules/*) return 0;;
  esac
  for allow in ${PLAN_HOME_ALLOW:-}; do
    # shellcheck disable=SC2254 # glob match is intentional
    case "$1" in $allow) return 0;; esac
  done
  return 1
}

strays=""
count=0
for f in $FILES; do
  [ -n "$f" ] || continue
  is_plan_shaped "$f" || continue
  is_allowed "$f" && continue
  strays="$strays$f
"
  count=$((count + 1))
done

if [ "$count" -gt 0 ]; then
  echo "check-plan-home: $count plan doc(s) outside the canonical home ($MODE):" >&2
  printf '%s' "$strays" | sed 's/^/  /' >&2
  echo "" >&2
  echo "  Every plan belongs to $CANON:" >&2
  echo "    * a plan is a ROW in $CANON (Now / Next / Later)" >&2
  echo "    * detail goes to docs/agents/<area>/<feature>/plan.md, linked from that row" >&2
  echo "    * fold each file above into a roadmap row, then archive it under" >&2
  echo "      docs/agents/<area>/completed/ — archive, never delete" >&2
  echo "" >&2
  echo "  Legitimate exception? add it to PLAN_HOME_ALLOW. Adopting a repo with a backlog?" >&2
  echo "  set PLAN_HOME_OFF=1, fold the strays, then turn the gate back on." >&2
  exit 1
fi

# The canonical doc must actually exist — a repo with no roadmap has no plan home at all.
if [ ! -f "$CANON" ]; then
  echo "check-plan-home: $CANON is missing — the project has no canonical plan home" >&2
  echo "  create it from docs/agents/_templates/ (or run the panoply adapt) before planning work" >&2
  exit 1
fi

echo "check-plan-home: OK"
