#!/usr/bin/env sh
# check-wireframe.sh — a user-facing change must have a wireframe (and its interviews) before backend.
#
# THE SEAM THIS CLOSES. The wireframe rung exists as doctrine (`.agents/rules/wireframe-first.md`) and
# had no mechanical backstop, so the rung survived only as advice. Advice is exactly what drifts: it is
# unverifiable by reading a diff, it gets skipped under time pressure, and nobody can tell it was
# skipped. This gate makes the presence of the artifact checkable.
#
# WHAT IT CHECKS, and nothing more — PRESENCE ONLY:
#   1. A change with a user-facing surface has a sibling `wireframe/index.html`.
#   2. That wireframe has an `interviews.md` beside it.
#   3. Otherwise, the spec records `n/a — <reason>` (the reason is required; a bare `n/a` is refused).
#
# WHAT IT DELIBERATELY DOES NOT CHECK. Not whether the wireframe is any good, not whether the layout
# suits the user, not whether the interviews were honest or the personas right, and not whether the
# screen matches the spec's stories. Those are review questions and are asked in the expert-review
# gate. A gate that claims to judge design would be measuring the wrong thing while looking rigorous —
# the failure this kit has already shipped once (a rule module asserting four checks, two of which did
# not exist). This gate answers exactly one question: does the artifact exist, and if not, was the skip
# written down with a reason. Nothing here is a quality claim.
#
#   sh scripts/check-wireframe.sh                # git mode — diff against the merge base / HEAD~1
#   sh scripts/check-wireframe.sh --since SHA    # explicit diff base (CI: the PR base SHA)
#   sh scripts/check-wireframe.sh --staged       # staged changes only (pre-commit context)
#
# Config (all optional):
#   WIREFRAME_OFF=1   disable entirely (deliberate exception — say so out loud)
#   WIREFRAME_GLOB=glob   override where specs live (default below)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${WIREFRAME_OFF:-0}" = "1" ] && { echo "check-wireframe: disabled (WIREFRAME_OFF=1)"; exit 0; }

# Specs are siblings of their plan, under docs/agents/<area>/<feature>/spec.md — the contract
# check-spec.sh, check-coverage.sh and check-plan-home.sh already use. No new layout is introduced.
WIREFRAME_GLOB="${WIREFRAME_GLOB:-docs/agents/*/*/spec.md}"

CODE_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|swift|c|cc|cpp|h|hpp|sql|sh|ps1|tf|yml|yaml)$'
CONFIG_RE='^\.github/|(^|/)\.pre-commit|(^|/)\.agents/'

MODE="git"; SINCE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --since)
    MODE="since"; SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-wireframe: refusing --since with an empty base SHA — set WIREFRAME_OFF=1 for a" >&2
      echo "  deliberate skip instead of silently checking nothing." >&2
      exit 2
    fi ;;
  "") MODE="git" ;;
  *) echo "check-wireframe: unknown argument '$1'" >&2; exit 2 ;;
esac

_diff_base_ok() {
  git rev-parse -q --verify "${1}^{commit}" >/dev/null 2>&1
}

case "$MODE" in
  staged) FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
          LABEL="staged change" ;;
  since)
    if ! _diff_base_ok "$SINCE"; then
      echo "check-wireframe: diff base '$SINCE' does not resolve in this checkout (shallow clone or" >&2
      echo "  wrong ref). Pass the PR base SHA explicitly, or set WIREFRAME_OFF=1 for a deliberate skip." >&2
      exit 2
    fi
    FILES="$(git diff --name-only --diff-filter=ACMR "$SINCE"...HEAD 2>/dev/null || true)"
    LABEL="change since $SINCE" ;;
  git)
    if [ -n "${GITHUB_BASE_REF:-}" ]; then
      FILES="$(git diff --name-only --diff-filter=ACMR "origin/${GITHUB_BASE_REF}...HEAD" 2>/dev/null || true)"
      LABEL="change vs origin/${GITHUB_BASE_REF}"
    elif git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then
      FILES="$(git diff --name-only --diff-filter=ACMR HEAD~1...HEAD 2>/dev/null || true)"
      LABEL="change in HEAD"
    else
      echo "check-wireframe: no parent commit to diff against (first commit or shallow checkout)." >&2
      echo "  Pass --since <sha>, or set WIREFRAME_OFF=1 for a deliberate skip." >&2
      exit 2
    fi ;;
esac

# Staged files always count, the way check-spec.sh does it: a pre-commit run sees only the index.
STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"

if [ -z "$(printf '%s%s' "$FILES" "$STAGED_FILES" | tr -d '[:space:]')" ]; then
  echo "check-wireframe: OK (no changed files in $LABEL)"
  exit 0
fi

# --- is this change STRUCTURAL? ---------------------------------------------------------------
# Same scope test as the other rungs. A typo, a copy change, or a wiring edit is not a part of the
# system, and demanding a wireframe for one is the ceremony the rule's own scope test forbids.
STRUCTURAL=0
for f in $FILES $STAGED_FILES; do
  [ -n "$f" ] || continue
  case "$f" in docs/*|*.md) continue ;; esac
  printf '%s' "$f" | grep -Eq "$CONFIG_RE" && continue
  printf '%s' "$f" | grep -Eq "$CODE_RE" || continue
  STRUCTURAL=1; break
done

if [ "$STRUCTURAL" -eq 0 ]; then
  echo "check-wireframe: OK (docs-only / no structural change in $LABEL)"
  exit 0
fi

# --- the change must carry a spec, and that spec decides --------------------------------------
# Only a spec this change ADDED or MODIFIED is judged. A tree-wide demand would fail every repo for
# work predating the rule — the tree-vs-change defect the interview check hit in check-spec.sh, which
# unit fixtures could not catch because a fixture has one spec by construction.
TOUCHED_SPECS=""
for f in $FILES $STAGED_FILES; do
  [ -n "$f" ] || continue
  case "$f" in */spec.md) TOUCHED_SPECS="$TOUCHED_SPECS $f" ;; esac
done

if [ -z "$(printf '%s' "$TOUCHED_SPECS" | tr -d ' ')" ]; then
  # No spec in this change is check-spec.sh's business, not this gate's. Say that, rather than
  # reporting a pass about a decision never made.
  echo "check-wireframe: OK (no spec touched by $LABEL — the spec rung owns that case, not this gate)"
  exit 0
fi

# Is the spec about something a user looks at? The authoritative statement is the spec's own `n/a`
# opt-out, checked FIRST so a spec that explicitly declines the rung is never dragged into it.
# Otherwise: does it describe user-surface behaviour? Vocabulary is a fallback, never the decider —
# a bare keyword match cannot tell a disclaimer ("no screen, internal only") from a requirement.
_user_facing() {
  _s="$1"
  if grep -qiE '(user-facing|wireframe)[^:]*:[^[:alnum:]]*n/a' "$_s" 2>/dev/null; then
    return 1     # explicitly not user-facing
  fi
  grep -qiE 'user (sees|can|clicks|opens|taps)|user stories|what a user can do|screen|page|form|dashboard' "$_s" 2>/dev/null
}

# Does the spec carry a REQUIRED `n/a — <reason>`? A bare `n/a` is refused: the reason is the whole
# point, because an n/a without one cannot be told apart from skipping the rung by accident.
_n_a_reason() {
  grep -iE '(user-facing|wireframe)[^:]*:[^[:alnum:]]*n/a[^[:alnum:]]*[—:-][[:space:]]*[^[:space:]]' "$1" 2>/dev/null
}

FAILED=0
REPORT=""
CHECKED=0

for spec in $TOUCHED_SPECS; do
  [ -f "$spec" ] || continue
  dir="$(dirname "$spec")"

  # Scaffolding is not a live spec — same exemption the coverage gate needed after its first real run.
  # An ARCHIVED pair (`docs/agents/<area>/completed/<slug>/`) is history, not a live claim. The rungs
  # judge a change's claim when it is MADE; a move into the archive makes every file in it "changed"
  # without making a new claim, so grading it again re-opens a decision already taken — against rules
  # that may postdate the artifact (this is how the launch rung read `[Unreleased]` as a claim and the
  # wireframe rung read a reversed opt-out as silence). check-plan-home.sh exempts the same path.
  case "$dir" in */_templates*|*/_template*|*/templates/*|*/examples/*|*/_examples*|*/completed/*) continue ;; esac

  if _n_a_reason "$spec" >/dev/null 2>&1; then
    CHECKED=$((CHECKED + 1))
    continue                      # an explicit, reasoned opt-out: legal, and recorded
  fi

  if grep -qiE '(user-facing|wireframe)[^:]*:[^[:alnum:]]*n/a' "$spec" 2>/dev/null; then
    FAILED=1
    REPORT="$REPORT$spec
    records 'n/a' for the wireframe rung with NO reason. The reason is required — without it, a
    deliberate opt-out cannot be told apart from skipping the rung by accident.
"
    continue
  fi

  if ! _user_facing "$spec"; then
    CHECKED=$((CHECKED + 1))
    continue                      # no user surface: the rung does not apply
  fi

  CHECKED=$((CHECKED + 1))
  WIRE="$dir/wireframe/index.html"
  INT="$dir/interviews.md"

  if [ ! -f "$WIRE" ]; then
    FAILED=1
    REPORT="$REPORT$spec
    has a user-facing surface but no $WIRE — the screen must be decided before the backend is
    fitted to it.
"
  elif [ ! -f "$INT" ]; then
    FAILED=1
    REPORT="$REPORT$dir/wireframe/index.html
    has no $INT — a wireframe nobody interviewed is the builder marking their own homework.
"
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo "check-wireframe: a user-facing change has no wireframe or no interviews ($LABEL):" >&2
  printf '%s' "$REPORT" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  The rung: expert input -> persona interviews -> wireframe -> interviews against the" >&2
  echo "  wireframe -> backend. The screen is decided first because changing it is cheap now and" >&2
  echo "  expensive once the API, state and tests are fitted to it." >&2
  echo "" >&2
  echo "  Add:  <dir>/wireframe/index.html   (framework-free, self-contained, no real copy)" >&2
  echo "        <dir>/interviews.md          (both rounds; findings name the decision they changed)" >&2
  echo "  Or, if there is genuinely no user-facing surface, put this IN THE SPEC:" >&2
  echo "        Wireframe: n/a — <reason>    (the reason is required)" >&2
  echo "" >&2
  echo "  Templates: docs/agents/_templates/wireframe/index.html and _templates/interviews.md" >&2
  echo "  Doctrine: .agents/rules/wireframe-first.md — deliberate exception? WIREFRAME_OFF=1, say so." >&2
  echo "" >&2
  echo "  This gate checks PRESENCE ONLY: that the artifact exists. It cannot tell whether the" >&2
  echo "  wireframe is any good or the interviews honest — those are review questions." >&2
  exit 1
fi

if [ "$CHECKED" -eq 0 ]; then
  echo "check-wireframe: OK (no spec with a user-facing surface in $LABEL — nothing to require)"
else
  echo "check-wireframe: OK ($CHECKED spec(s) checked: wireframe + interviews present, or a reasoned n/a)"
fi
exit 0
