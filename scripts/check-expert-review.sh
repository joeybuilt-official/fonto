#!/usr/bin/env sh
# check-expert-review.sh — CI gate verifying expert review evidence for non-trivial PRs.
# Exits 0 if review evidence found or PR is trivial; exits 1 with reason if missing.
#
#   sh scripts/check-expert-review.sh              # git mode — diff against origin/<base> / HEAD~1
#   sh scripts/check-expert-review.sh --since SHA  # explicit diff base (CI: the PR base SHA)
#   sh scripts/check-expert-review.sh --staged     # staged changes only (pre-commit context)
#
# Config (all optional):
#   EXPERT_REVIEW_OFF=1                disable entirely (deliberate exception — say so out loud)
#   EXPERT_REVIEW_REQUIRE_SIGNOFFS=1   additionally require ≥2 persona sign-offs in the PR body
#   EXPERT_REVIEW_GLOB=<glob>          override where a plan doc lives (space-separated alternatives)
#   EXPERT_REVIEW_FILES=<regex>        override what counts as a "code" (non-trivial) file
#
# WHAT THIS GATE ASKS — and what it used to ask:
#   It asks whether THIS change carries review evidence. It used to ask whether the repo had EVER
#   contained any plan.md and ANY checklist line, tree-wide. Those two checks were TREE-GLOBAL:
#   `find docs/agents -name plan.md` matched a plan for an unrelated feature, and
#   `grep -rlE '^[[:space:]]*- \[[ xX]\]' docs/agents` matched any checkbox anywhere in docs/. So
#   once a repo held one finished plan, the gate passed forever — for every PR, including a
#   200-line structural change with no plan and no review. It could not distinguish "this PR was
#   reviewed" from "this repo has ever contained a plan", which are different questions and only the
#   first one is a review gate.
#
#   The rule now: review evidence must be a PLAN DOC the change itself ADDED or MODIFIED. Presence
#   in the tree is not evidence about the change; being touched by the change is. A plan the PR
#   edits (checking off milestones, recording a Build note) counts exactly as an added one does,
#   because recording the review in the plan is the act the rule asks for — and a plan written in
#   the same PR satisfies the gate the moment it appears, the "observe its own remedy" property
#   check-spec.sh and check-algorithm.sh both have.
#
# WHAT THIS GATE CANNOT DO — read it before trusting a green run:
#   It checks that a plan doc for this work exists AND was touched by this change. It cannot tell
#   whether the plan is good, whether the checklist items are meaningful, or whether a named
#   reviewer actually read the diff. A file can be touched to satisfy a gate without any review
#   happening. That residue is a review problem, not an automation problem — but it is now a
#   residue, not the whole signal, which is the difference between this gate and its predecessor.
set -eu

# A declared escape hatch, matching ALGORITHM_OFF / PLAN_HOME_OFF / SPEC_OFF / DOCS_OFF. This gate
# blocks ordinary work, so the alternative to a named hatch is an undeclared `--no-verify`.
[ "${EXPERT_REVIEW_OFF:-0}" = "1" ] && { echo "check-expert-review: disabled (EXPERT_REVIEW_OFF=1)"; exit 0; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Where a plan doc lives: the canonical per-feature plan home, plus the ONE lightweight docs/PLAN.md
# a project too small for the docs/agents spine keeps (see .agents/rules/workflow.md → Planning
# Workflow). Same homes check-algorithm.sh accepts, so the two gates cannot disagree about what a
# plan is. A file at any OTHER plan-shaped path is a stray and is not evidence (check-plan-home.sh
# already refuses it).
PLAN_GLOB="${EXPERT_REVIEW_GLOB:-docs/agents/*/*/plan.md docs/PLAN.md docs/agents/PLAN.md}"

# What counts as a structural ("code") change. Docs/rules-only edits are exempt: a rule module, a
# note, or a copy change is not a part of the system, and demanding a plan for a typo fix is exactly
# the ceremony the Algorithm's own scope test forbids. Mirrors check-spec.sh / check-algorithm.sh so
# a change is classified identically by every gate.
CODE_RE='(^|/)(src|apps|packages|lib|scripts|e2e|infra|migrations)/|\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|swift|c|cc|cpp|h|hpp|sql|sh|ps1|tf|yml|yaml)$'
[ -n "${EXPERT_REVIEW_FILES:-}" ] && CODE_RE="$EXPERT_REVIEW_FILES"

# --- argument parsing --------------------------------------------------------
MODE="git"
SINCE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --since)
    MODE="since"
    SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-expert-review: refusing --since with an empty base SHA — set EXPERT_REVIEW_OFF=1" >&2
      echo "  for a deliberate skip instead of silently checking nothing." >&2
      exit 2
    fi
    ;;
  "")       MODE="git" ;;
  *) echo "check-expert-review: unknown argument '$1'" >&2; exit 2 ;;
esac

# --- collect the changed files ----------------------------------------------
# Every mode must produce a real diff. If a base does not resolve (a shallow CI checkout, a wrong
# ref, a fixture with no history), the diff comes back EMPTY and the gate reports OK — passing for
# the wrong reason, which is indistinguishable from the gate working. So verify the base resolves
# and refuse loudly instead of quietly checking nothing.
diff_files() {
  _base="$1"
  if ! git rev-parse -q --verify "${_base}^{commit}" >/dev/null 2>&1; then
    echo "check-expert-review: diff base '$_base' does not resolve in this checkout (shallow clone or" >&2
    echo "  wrong ref). Pass the PR base SHA explicitly, or set EXPERT_REVIEW_OFF=1 for a deliberate skip." >&2
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
      echo "check-expert-review: no parent commit to diff against (first commit or shallow checkout)." >&2
      echo "  Pass --since <sha>, or set EXPERT_REVIEW_OFF=1 for a deliberate skip." >&2
      exit 2
    fi
    ;;
esac

if [ -z "$FILES" ]; then
  echo "check-expert-review: OK (no changed files)"
  exit 0
fi

# --- trivial escape hatches --------------------------------------------------
# 1. PR has label "trivial"
# 2. HEAD commit message starts with "trivial:"
# 3. Only 1 file changed, ≤15 lines added, no schema/API/interface file
is_trivial=0

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  PR_NUMBER="${GITHUB_PR_NUMBER:-${CI_PR_NUMBER:-}}"
  if [ -n "$PR_NUMBER" ]; then
    if gh pr view "$PR_NUMBER" --json labels --jq '.labels[].name' 2>/dev/null | grep -q '^trivial$'; then
      is_trivial=1
      echo "check-expert-review: PR #$PR_NUMBER has 'trivial' label — skipping"
    fi
  fi
fi

if [ "$is_trivial" -eq 0 ]; then
  LATEST_MSG="$(git log -1 --pretty=%s 2>/dev/null || echo "")"
  case "$LATEST_MSG" in
    trivial:*) is_trivial=1; echo "check-expert-review: commit message has 'trivial:' prefix — skipping" ;;
  esac
fi

if [ "$is_trivial" -eq 0 ]; then
  n_files="$(printf '%s\n' "$FILES" | grep -vc '^$' || true)"
  # Lines added across the change, summed from numstat's added column. The old `--stat | tail -1`
  # read a TOTAL row in some git versions and a filename in others, so it was not a count at all;
  # numstat is per-file and sums honestly. Fields 1-2 are "-" for binary files, which awk treats as
  # 0 — a binary change should not read as 15 added lines.
  n_lines="$(
    case "$MODE" in
      staged) git diff --cached --numstat 2>/dev/null || true ;;
      since)  git diff --numstat "$SINCE"...HEAD 2>/dev/null || true ;;
      *)      git diff --numstat HEAD~1...HEAD 2>/dev/null || true ;;
    esac | awk '{a+=$1} END {print a+0}'
  )"
  n_schema="$(printf '%s\n' "$FILES" | grep -cE '\.(sql|prisma|graphql|proto|openapi|yaml|yml)$' || true)"
  if [ "$n_files" -eq 1 ] && [ "${n_lines:-0}" -le 15 ] && [ "${n_schema:-0}" -eq 0 ]; then
    echo "check-expert-review: change is trivial (1 file, ${n_lines} lines, no schema) — skipping"
    is_trivial=1
  fi
fi

if [ "$is_trivial" -eq 1 ]; then
  echo "check-expert-review: OK (trivial)"
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
  echo "check-expert-review: OK (docs-only / no structural change in $LABEL)"
  exit 0
fi

# --- is there review evidence for THIS change? ------------------------------
# The evidence must be a plan doc the CHANGE ADDED or MODIFIED — a path that is BOTH shaped like a
# plan home (`$PLAN_GLOB`) AND present in `$FILES`. Either half alone is the old defect: the glob
# alone is "a plan exists in the tree"; the changed-file list alone would accept a stray
# `<feature>-plan.md` at the repo root that check-plan-home.sh refuses.
#
# This is what makes the gate answer "was THIS change reviewed". A repo that holds a finished plan
# for feature A contributes nothing here unless the change touches that file — so a large
# unreviewed change to feature B FAILS even though the tree is full of plans.
evidence=""
for f in $FILES; do
  [ -n "$f" ] || continue
  for g in $PLAN_GLOB; do
    # shellcheck disable=SC2254 # glob match against a single path is intentional
    case "$f" in $g) evidence="$f"; break ;; esac
  done
  [ -n "$evidence" ] && break
done

if [ -z "$evidence" ]; then
  echo "check-expert-review: structural change in $LABEL has no review evidence." >&2
  echo "  A plan doc must exist AND be added or modified by this change — a plan that merely" >&2
  echo "  sits in the tree is not evidence that THIS change was reviewed." >&2
  echo "  Home(s) checked: $PLAN_GLOB" >&2
  echo "" >&2
  echo "  Add or update the plan doc for this work:" >&2
  echo "" >&2
  echo "    1. cp docs/agents/_templates/plan.md docs/agents/<area>/<slug>/plan.md" >&2
  echo "    2. write the milestones, and keep a '- [ ] <step>' checklist in the same file" >&2
  echo "    3. re-run this gate — it passes the moment the plan is part of the change" >&2
  echo "" >&2
  echo "  Routine work inside an existing pattern (typo, copy change, behavior-preserving refactor)" >&2
  echo "  is exempt: a 1-file ≤15-line no-schema change skips this gate, as does a 'trivial' PR" >&2
  echo "  label or a 'trivial:' commit prefix. Doctrine: .agents/rules/workflow.md → Expert Review." >&2
  echo "  Deliberate exception? EXPERT_REVIEW_OFF=1 — say that you used it." >&2
  exit 1
fi

# The plan must actually carry planning: at least one checklist line, in the SAME file we just
# accepted as evidence. Checking the evidence file rather than `grep -rl docs/agents` is the second
# half of the scope fix — an unrelated checklist elsewhere in docs/ no longer satisfies this.
if ! grep -qE '^[[:space:]]*- \[[ xX]\]' "$evidence" 2>/dev/null; then
  echo "check-expert-review: $evidence carries no checklist item ('- [ ] <step>')." >&2
  echo "  A plan for non-trivial work lists its steps; an unchecked or checked item both count." >&2
  echo "  Doctrine: .agents/rules/workflow.md → Expert Review." >&2
  exit 1
fi

# --- opt-in: PR description carries >=2 persona sign-offs --------------------
# OPT-IN ONLY. This used to arm itself whenever `gh` happened to be authenticated, which meant adding
# a GH_TOKEN to any workflow would silently start requiring sign-offs across every repo carrying the
# kit, all at once. Enforcement that switches on as a side effect of a credential is not enforcement
# anyone agreed to, so it needs EXPERT_REVIEW_REQUIRE_SIGNOFFS=1.
if [ "${EXPERT_REVIEW_REQUIRE_SIGNOFFS:-0}" = "1" ] \
   && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  PR_NUMBER="${GITHUB_PR_NUMBER:-${CI_PR_NUMBER:-}}"
  if [ -n "$PR_NUMBER" ]; then
    body="$(gh pr view "$PR_NUMBER" --json body --jq .body 2>/dev/null || echo "")"
    # Count distinct persona sign-offs: Security, Performance, Maintainability, UX, <domain>
    signoffs=$(echo "$body" | grep -oE '^>?\s*(Security|Performance|Maintainability|UX|[A-Z][a-z]+):\s*(✓|approved|LGTM|sign.?off)' | sort -u | wc -l | tr -d ' ')
    if [ "${signoffs:-0}" -lt 2 ]; then
      echo "check-expert-review: PR #$PR_NUMBER needs ≥2 persona sign-offs in description (found $signoffs)" >&2
      exit 1
    fi
  fi
fi

echo "check-expert-review: OK (plan touched by this change: $evidence — $LABEL)"
exit 0
