#!/usr/bin/env sh
# check-algorithm.sh — the Algorithm-pass gate: a structural change must show its step-2 artifact.
#
# Enforces the Algorithm pass (.agents/rules/algorithm.md) mechanically, in the same spirit as the
# plan-home and docs gates: the rule is doctrine, and doctrine drifts.
#
# Why specifically the DELETION step: of the five steps (question, delete, simplify, accelerate,
# automate) deletion is the only one whose output is ABSENCE. There is nothing to show at the end, so
# nothing reminds anyone it was skipped, and a pass that is never checked becomes a pass that is never
# run. Requiring the written candidate list is the cheapest way to keep the step real.
#
#   sh scripts/check-algorithm.sh              # git mode — diff against the merge base / HEAD~1
#   sh scripts/check-algorithm.sh --since SHA  # explicit diff base (CI: the PR base SHA)
#   sh scripts/check-algorithm.sh --staged     # staged changes only (pre-commit context)
#
# Config (all optional):
#   ALGORITHM_OFF=1        disable entirely (deliberate exception — say so out loud)
#   ALGORITHM_FILES=glob   override what counts as "code" (default below)
#
# WHAT THIS GATE CANNOT DO — read it before trusting a green run:
#   It checks that the step-2 ARTIFACT exists, not that the deletion list is any good. It cannot tell
#   whether the requester named in step 1 is real, whether the simplification is actually simpler, or
#   whether the measured number is honest. Those stay review questions and must be asked explicitly in
#   the expert-review gate. A gate that passes while a requirement went unexamined is a gate measuring
#   the wrong thing.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${ALGORITHM_OFF:-0}" = "1" ] && { echo "check-algorithm: disabled (ALGORITHM_OFF=1)"; exit 0; }

# Where the plan home lives. A project too small for the docs/agents spine keeps ONE lightweight
# docs/PLAN.md (see .agents/rules/workflow.md → Planning Workflow); both are accepted here.
PLAN_GLOB="${ALGORITHM_PLAN_GLOB:-docs/agents/*/*/plan.md docs/PLAN.md docs/agents/PLAN.md}"
# What counts as a structural change. Docs/rules-only edits are exempt: a rule module, a note, or a
# copy change is not a part of the system, and asking for a deletion list on a typo fix is exactly the
# ceremony the rule's own scope test forbids.
CODE_RE='(^|/)(src|apps|packages|lib|scripts|e2e|infra|migrations)/|\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|swift|c|cc|cpp|h|hpp|sql|sh|ps1|tf|yml|yaml)$'

MODE="git"
SINCE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --since)
    MODE="since"
    SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-algorithm: refusing --since with an empty base SHA — set ALGORITHM_OFF=1 for a" >&2
      echo "  deliberate skip instead of silently checking nothing." >&2
      exit 2
    fi
    ;;
  "")       MODE="git" ;;
  *) echo "check-algorithm: unknown argument '$1'" >&2; exit 2 ;;
esac

# --- collect the changed files ----------------------------------------------
# Every mode must produce a real diff. If a base does not resolve (a shallow CI checkout, a wrong ref,
# a fixture with no history), the diff comes back EMPTY and the gate reports OK — passing for the
# wrong reason, which is indistinguishable from the gate working. That bug shipped in the canary's
# first version: green locally, 4/9 red in CI. So verify the base resolves and refuse loudly if it
# does not, instead of quietly checking nothing.
diff_files() {
  _base="$1"
  if ! git rev-parse -q --verify "${_base}^{commit}" >/dev/null 2>&1; then
    echo "check-algorithm: diff base '$_base' does not resolve in this checkout (shallow clone or" >&2
    echo "  wrong ref). Pass the PR base SHA explicitly, or set ALGORITHM_OFF=1 for a deliberate skip." >&2
    exit 2
  fi
  git diff --name-only --diff-filter=ACMR "$_base"...HEAD 2>/dev/null || true
}

case "$MODE" in
  staged)
    FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
    LABEL="staged change"
    ;;
  since)
    FILES="$(diff_files "$SINCE")"
    LABEL="change since $SINCE"
    ;;
  git)
    if [ -n "${GITHUB_BASE_REF:-}" ]; then
      FILES="$(diff_files "origin/${GITHUB_BASE_REF}")"
      LABEL="change vs origin/${GITHUB_BASE_REF}"
    elif git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then
      FILES="$(git diff --name-only --diff-filter=ACMR HEAD~1...HEAD 2>/dev/null || true)"
      LABEL="change in HEAD"
    else
      # No parent commit (a fixture's first commit, or a depth-1 checkout). Say so rather than
      # reporting a clean result about a comparison that never happened.
      echo "check-algorithm: no parent commit to diff against (first commit or shallow checkout)." >&2
      echo "  Pass --since <sha>, or set ALGORITHM_OFF=1 for a deliberate skip." >&2
      exit 2
    fi
    ;;
esac

if [ -z "$FILES" ]; then
  echo "check-algorithm: OK (no changed files)"
  exit 0
fi

# --- is this change structural? ---------------------------------------------
STRUCTURAL=0
for f in $FILES; do
  [ -n "$f" ] || continue
  case "$f" in docs/*|*.md|*/completed/*) continue ;; esac
  printf '%s' "$f" | grep -Eq "$CODE_RE" || continue
  STRUCTURAL=1
  break
done

if [ "$STRUCTURAL" -eq 0 ]; then
  echo "check-algorithm: OK (docs-only / no structural change in $LABEL)"
  exit 0
fi

# --- does any plan doc carry the step-2 artifact? ---------------------------
# A plan doc must exist AND carry a Deletion candidates section. The heading is matched loosely so a
# repo using different capitalisation is not punished for it; the CONTENT under it is not judged.
PLANS=""
for g in $PLAN_GLOB; do
  for p in $g; do
    [ -f "$p" ] || continue
    case " $PLANS " in *" $p "*) ;; *) PLANS="$PLANS $p" ;; esac
  done
done

FOUND_PLAN=""
FOUND_SECTION=""
for p in $PLANS; do
  [ -n "$FOUND_PLAN" ] || FOUND_PLAN="$p"
  if grep -Eqi '^#+[[:space:]]*deletion[[:space:]]+candidates' "$p"; then
    FOUND_SECTION="$p"
    break
  fi
done

if [ -n "$FOUND_SECTION" ]; then
  echo "check-algorithm: OK (deletion candidates present in $FOUND_SECTION)"
  exit 0
fi

echo "check-algorithm: structural change in $LABEL has no Algorithm pass (step 2) artifact." >&2
if [ -n "$FOUND_PLAN" ]; then
  echo "  plan doc found: $FOUND_PLAN — but it carries no 'Deletion candidates' section." >&2
else
  echo "  no plan doc found under: $PLAN_GLOB" >&2
fi
echo "" >&2
echo "  The Algorithm pass runs in order — question, DELETE, simplify, accelerate, automate — and" >&2
echo "  deletion is the only step that leaves no artifact, so it is the only one that gets skipped." >&2
echo "  Add to the plan doc for this change:" >&2
echo "" >&2
echo "    ## The Algorithm pass" >&2
echo "    - Question:  who asked, and which constraint does it serve?" >&2
echo "    - Delete:    what can be removed instead? (candidates below)" >&2
echo "    - Simplify:  the least shape that satisfies the named requirement" >&2
echo "    - Accelerate: the measured rate today, and the bottleneck" >&2
echo "    - Automate:  is this genuinely last, and were 1-3 done on it?" >&2
echo "" >&2
echo "    ### Deletion candidates" >&2
echo "    | Candidate | Removed? | Why |" >&2
echo "" >&2
echo "  An empty table must be ARGUED, not left blank — 'nothing can be deleted here' is a conclusion" >&2
echo "  to defend. Copy the section from docs/agents/_templates/plan.md." >&2
echo "" >&2
echo "  Doctrine: .agents/rules/algorithm.md. Deliberate exception (a spike, a one-file fix inside an" >&2
echo "  existing pattern)? Say so out loud and set ALGORITHM_OFF=1 for that change — do not silently" >&2
echo "  bypass it." >&2
exit 1
