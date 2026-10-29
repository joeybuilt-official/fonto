#!/usr/bin/env sh
# check-coverage.sh — the spec→plan rivet: every requirement in a spec must be covered by its plan.
#
# THE SEAM THIS CLOSES. The kit has a spec rung (check-spec.sh) and a plan rung (check-plan-home.sh +
# check-algorithm.sh). Each is sound, and each is blind to the other: nothing has ever verified that a
# plan COVERS what its spec requires. A plan can look thorough, pass every gate, and quietly omit a
# third of the requirements — and nothing in the kit can see it. That failure is silent by
# construction, which is why it survived this long.
#
# WHY A GATE RATHER THAN ADVICE. A rule that says "make sure your plan covers the spec" is exactly the
# rule that drifts: it is unverifiable by reading a diff, so it gets skipped under time pressure and
# nobody can tell. The kit's own doctrine names this — an unchecked rule drifts, and the whole reason
# this kit exists is that rules drift. So the coverage rule gets the same treatment as every other
# promise here: a mechanical check, a canary that goes red, and a declared escape hatch.
#
# WHAT IT CHECKS, precisely — two things, both cheap and both non-judgemental:
#
#   1. Every `FR-NNN` in the spec is claimed by at least one milestone in the plan's coverage table.
#   2. Every `FR-NNN` the plan claims exists in the spec (a citation to a requirement that is not
#      there is a dangling reference — the plan promises to satisfy something the spec never promised).
#
# The second half is not decoration. The first half alone is satisfiable by adding rows; the pair
# together means the two artifacts must actually AGREE, which is the property the seam needs.
#
# HOW THE CROSS-REFERENCE IS EXPRESSED. A plan carries a coverage table:
#
#     ## Spec coverage
#     | Requirement | Milestone |
#     |---|---|
#     | FR-001 | M1 |
#     | FR-013 | M1, M4, M5 |
#
# The table is the checkable form of "this milestone serves that requirement". Prose milestones are
# not parsed — prose cannot be checked, and a check that reads prose is a check that guesses.
#
#   sh scripts/check-coverage.sh                # git mode — diff against the merge base / HEAD~1
#   sh scripts/check-coverage.sh --since SHA    # explicit diff base (CI: the PR base SHA)
#   sh scripts/check-coverage.sh --staged       # staged changes only (pre-commit context)
#
# Config (all optional):
#   COVERAGE_OFF=1    disable entirely (deliberate exception — say so out loud)
#   COVERAGE_GLOB=glob  override where specs live (default below)
#
# WHAT THIS GATE CANNOT DO — read it before trusting a green run:
#   It verifies that every requirement is CLAIMED by a milestone, and that every claim corresponds to a
#   real requirement. It cannot tell whether the milestone genuinely delivers the requirement, whether
#   the milestone is any good, whether the plan is feasible, or whether the requirement itself is worth
#   what it costs. A plan can cite FR-001 on a milestone that does nothing for it and pass this gate.
#   That residue is a review question and must be asked there. This gate closes the "was it mentioned
#   at all" seam — not the "is it true" one.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${COVERAGE_OFF:-0}" = "1" ] && { echo "check-coverage: disabled (COVERAGE_OFF=1)"; exit 0; }

# Specs are siblings of their plan, under docs/agents/<area>/<feature>/spec.md — the same contract
# check-spec.sh and check-plan-home.sh already use. No new layout is introduced.
COVERAGE_GLOB="${COVERAGE_GLOB:-docs/agents/*/*/spec.md}"

CODE_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|swift|c|cc|cpp|h|hpp|sql|sh|ps1|tf|yml|yaml)$'
CONFIG_RE='^\.github/|(^|/)\.pre-commit|(^|/)(tsconfig|eslint\.config|vite\.config|playwright\.config|jest\.config|vitest\.config|docker-compose)[^/]*$|(^|/)\.agents/'

MODE="git"
SINCE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --since)
    MODE="since"
    SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-coverage: refusing --since with an empty base SHA — set COVERAGE_OFF=1 for a" >&2
      echo "  deliberate skip instead of silently checking nothing." >&2
      exit 2
    fi
    ;;
  "")       MODE="git" ;;
  *) echo "check-coverage: unknown argument '$1'" >&2; exit 2 ;;
esac

diff_files() {
  _base="$1"
  if ! git rev-parse -q --verify "${_base}^{commit}" >/dev/null 2>&1; then
    echo "check-coverage: diff base '$_base' does not resolve in this checkout (shallow clone or" >&2
    echo "  wrong ref). Pass the PR base SHA explicitly, or set COVERAGE_OFF=1 for a deliberate skip." >&2
    exit 2
  fi
  git diff --name-only --diff-filter=ACMR "$_base"...HEAD 2>/dev/null || true
}

case "$MODE" in
  staged) FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
          LABEL="staged change" ;;
  since)  FILES="$(diff_files "$SINCE")"
          LABEL="change since $SINCE" ;;
  git)
    if [ -n "${GITHUB_BASE_REF:-}" ]; then
      FILES="$(diff_files "origin/${GITHUB_BASE_REF}")"
      LABEL="change vs origin/${GITHUB_BASE_REF}"
    elif git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then
      FILES="$(git diff --name-only --diff-filter=ACMR HEAD~1...HEAD 2>/dev/null || true)"
      LABEL="change in HEAD"
    else
      echo "check-coverage: no parent commit to diff against (first commit or shallow checkout)." >&2
      echo "  Pass --since <sha>, or set COVERAGE_OFF=1 for a deliberate skip." >&2
      exit 2
    fi ;;
esac

if [ -z "$FILES" ]; then
  echo "check-coverage: OK (no changed files)"
  exit 0
fi

# --- is this change structural? -------------------------------------------------------------
# Coverage is demanded only when the change is structural, for the same reason check-spec.sh demands a
# spec only then: a typo fix, a copy change, or a wiring edit is not a part of the system, and asking
# for requirement coverage there is exactly the ceremony the rule's own scope test forbids.
STRUCTURAL=0
for f in $FILES; do
  [ -n "$f" ] || continue
  case "$f" in docs/*|*.md|*/completed/*) continue ;; esac
  printf '%s' "$f" | grep -Eq "$CONFIG_RE" && continue
  printf '%s' "$f" | grep -Eq "$CODE_RE" || continue
  STRUCTURAL=1
  break
done

if [ "$STRUCTURAL" -eq 0 ]; then
  echo "check-coverage: OK (docs-only / no structural change in $LABEL)"
  exit 0
fi

# --- find the spec/plan pair(s) this change touched ------------------------------------------
# CHANGE-SCOPED, deliberately. A tree-wide demand would fail a repo for a pair written before this
# rule existed, and would make this gate a second, stricter spec gate rather than a rivet between the
# two. Only a spec or plan the change ADDED or MODIFIED is judged.
TOUCHED=""
for f in $FILES; do
  [ -n "$f" ] || continue
  case "$f" in */spec.md|*/plan.md) TOUCHED="$TOUCHED $f" ;; esac
done
for f in $(git diff --cached --name-only --diff-filter=AM 2>/dev/null || true); do
  case "$f" in */spec.md|*/plan.md) TOUCHED="$TOUCHED $f" ;; esac
done

if [ -z "$(printf '%s' "$TOUCHED" | tr -d ' ')" ]; then
  # A structural change with no spec or plan of its own is check-spec.sh's and check-plan-home.sh's
  # business, not this gate's. Say so rather than reporting a pass about a comparison never made.
  echo "check-coverage: OK (no spec/plan pair touched by $LABEL — nothing to join)"
  exit 0
fi

# --- extract ids ----------------------------------------------------------------------------
# A spec declares requirements as `- **FR-001**: ...`. A plan's coverage table cites them as cells.
# Both are read with the same id shape so the two sides are comparable.
_ids_in_spec() { grep -oE 'FR-[0-9]+' "$1" 2>/dev/null | sort -u; }
_ids_in_plan() { grep -oE 'FR-[0-9]+' "$1" 2>/dev/null | sort -u; }

_spec_has_ids() { [ -n "$(_ids_in_spec "$1")" ]; }

_have_coverage_section() {
  # Loose heading match, the same way check-algorithm.sh matches `Deletion candidates`: a gate that
  # demands one exact string fails a repo for phrasing.
  grep -qiE '^#+[[:space:]]*.*(spec[[:space:]]+coverage|requirement.*coverage|coverage.*requirement)' "$1" 2>/dev/null
}

FAILED=0
REPORT=""
CHECKED=0

for pair_dir in $(printf '%s' "$TOUCHED" | tr ' ' '\n' | grep -v '^$' | xargs -n1 dirname 2>/dev/null | sort -u); do
  SPEC="$pair_dir/spec.md"
  PLAN="$pair_dir/plan.md"

  # Scaffolding is not a live pair. `_templates/` carries illustrative requirements and milestones so
  # the shape is visible; joining them would fail every repo that ships the kit the moment one template
  # example stopped matching another. The same applies to any directory whose name is a template or an
  # example. Exempt by path, not by content — a content rule would be gameable.
  # An ARCHIVED pair (`docs/agents/<area>/completed/<slug>/`) is history, not a live claim. The rungs
  # judge a change's claim when it is MADE; a move into the archive makes every file in it "changed"
  # without making a new claim, so grading it again re-opens a decision already taken — against rules
  # that may postdate the artifact (this is how the launch rung read `[Unreleased]` as a claim and the
  # wireframe rung read a reversed opt-out as silence). check-plan-home.sh exempts the same path.
  case "$pair_dir" in */_templates*|*/_template*|*/templates/*|*/examples/*|*/_examples*|*/completed/*) continue ;; esac

  # Only judge a pair where BOTH sides exist. A spec with no plan yet is the spec rung's state (legal,
  # and check-plan-home.sh's business); a plan with no spec is likewise not this gate's to invent.
  [ -f "$SPEC" ] || continue
  [ -f "$PLAN" ] || continue

  # A spec with no requirements at all cannot have coverage joined to it. That is a spec-quality
  # question (check-spec.sh already refuses a spec with no spec; a spec with no FR is review's).
  _spec_has_ids "$SPEC" || continue
  CHECKED=$((CHECKED + 1))

  SPEC_IDS="$(_ids_in_spec "$SPEC")"

  if ! _have_coverage_section "$PLAN"; then
    FAILED=1
    REPORT="$REPORT$PLAN
    carries no '## Spec coverage' table, so no requirement in $SPEC can be shown as covered.
"
    continue
  fi

  PLAN_IDS="$(_ids_in_plan "$PLAN")"

  MISSING=""
  for id in $SPEC_IDS; do
    printf '%s' "$PLAN_IDS" | grep -qx "$id" || MISSING="$MISSING $id"
  done

  DANGLING=""
  for id in $PLAN_IDS; do
    printf '%s' "$SPEC_IDS" | grep -qx "$id" || DANGLING="$DANGLING $id"
  done

  if [ -n "$MISSING" ]; then
    FAILED=1
    REPORT="$REPORT$SPEC — requirements with NO milestone in $PLAN:$MISSING
"
  fi
  if [ -n "$DANGLING" ]; then
    FAILED=1
    REPORT="$REPORT$PLAN — cites requirements that do not exist in $SPEC:$DANGLING
"
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo "check-coverage: the spec and its plan do not agree ($LABEL):" >&2
  printf '%s' "$REPORT" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  Every requirement in a spec must be claimed by a milestone in its plan, and every" >&2
  echo "  requirement a plan cites must exist in the spec. Add to the plan doc:" >&2
  echo "" >&2
  echo "    ## Spec coverage" >&2
  echo "    | Requirement | Milestone |" >&2
  echo "    |---|---|" >&2
  echo "    | FR-001 | M1 |" >&2
  echo "    | FR-013 | M1, M4, M5 |" >&2
  echo "" >&2
  echo "  A requirement with no milestone is either a milestone you have not written, or a" >&2
  echo "  requirement you have decided not to serve — in which case delete it from the spec rather" >&2
  echo "  than leaving it uncovered, so the artifact states what is actually being built." >&2
  echo "" >&2
  echo "  This gate checks that each requirement is CLAIMED, and that claims are real. Whether a" >&2
  echo "  milestone genuinely delivers its requirement is a review question — ask it there." >&2
  echo "  Doctrine: .agents/rules/spec.md. Deliberate exception? COVERAGE_OFF=1 — say so." >&2
  exit 1
fi

if [ "$CHECKED" -eq 0 ]; then
  echo "check-coverage: OK (no spec/plan pair with requirements in $LABEL — nothing compared)"
else
  echo "check-coverage: OK ($CHECKED pair(s): every requirement covered, no dangling citation, in $LABEL)"
fi
exit 0
