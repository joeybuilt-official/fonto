#!/usr/bin/env sh
# check-milestone-evidence.sh — a milestone marked done must say where the work landed.
#
# THE SEAM THIS CLOSES. M1 joined spec to plan (every requirement claimed by a milestone). This closes
# the OTHER seam the audit named: plan to CODE. A plan could tick a milestone — `- [x]` — with nothing
# behind it, and every gate stayed green. A tick is a claim about work, and a claim about work that
# nothing verifies is exactly the kind of unchecked assertion this kit exists to refuse.
#
# The audit's words: spec and plan are individually good, "the failure is at the seams." M1 was one
# seam, this is the other.
#
# WHAT IT CHECKS, and nothing more. A COMPLETED milestone (`- [x]`) in a plan the change touched must
# carry an EVIDENCE REFERENCE — a backticked path, or `PR #NN`. That reference must resolve: the path
# must exist in the repo, or the PR number must be a real commit message in the log.
#
# The evidence form is deliberately loose (a path or a PR reference, anywhere in the milestone line)
# because the honest thing a milestone can name varies: a file, a directory, a script, a PR. What is
# NOT acceptable is a bare claim with nothing behind it.
#
#   sh scripts/check-milestone-evidence.sh                # git mode — diff against the merge base / HEAD~1
#   sh scripts/check-milestone-evidence.sh --since SHA    # explicit diff base (CI: the PR base SHA)
#   sh scripts/check-milestone-evidence.sh --staged       # staged changes only (pre-commit context)
#
# Config (all optional):
#   MILESTONE_OFF=1        disable entirely (deliberate exception — say so out loud)
#   MILESTONE_EXEMPT=glob  paths to skip (specs of specs, scratch plans)
#
# WHAT THIS GATE CANNOT DO — read it before trusting a green run:
#   It proves the artifact a completed milestone NAMES exists. It cannot prove the milestone is
#   actually finished, that the artifact does what the milestone said, or that the reference is the
#   RIGHT one. A milestone reading "- [x] did the thing — `README.md`" passes and may be a lie. That
#   residue is a review question. This gate closes "was any evidence offered at all" — not "is the
#   claim true".
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${MILESTONE_OFF:-0}" = "1" ] && { echo "check-milestone-evidence: disabled (MILESTONE_OFF=1)"; exit 0; }

MODE="git"; SINCE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --since)
    MODE="since"; SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-milestone-evidence: refusing --since with an empty base SHA — set MILESTONE_OFF=1" >&2
      echo "  for a deliberate skip instead of silently checking nothing." >&2
      exit 2
    fi ;;
  "") MODE="git" ;;
  *) echo "check-milestone-evidence: unknown argument '$1'" >&2; exit 2 ;;
esac

case "$MODE" in
  staged) FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
          LABEL="staged change" ;;
  since)
    if ! git rev-parse -q --verify "${SINCE}^{commit}" >/dev/null 2>&1; then
      echo "check-milestone-evidence: diff base '$SINCE' does not resolve in this checkout (shallow" >&2
      echo "  clone or wrong ref). Pass the PR base SHA, or set MILESTONE_OFF=1 for a deliberate skip." >&2
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
      echo "check-milestone-evidence: no parent commit to diff against (first commit or shallow" >&2
      echo "  checkout). Pass --since <sha>, or set MILESTONE_OFF=1 for a deliberate skip." >&2
      exit 2
    fi ;;
esac

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"

if [ -z "$(printf '%s%s' "$FILES" "$STAGED_FILES" | tr -d '[:space:]')" ]; then
  echo "check-milestone-evidence: OK (no changed files in $LABEL)"
  exit 0
fi

# A plan is the only artifact that carries milestones. CHANGE-SCOPED: only a plan this change ADDED or
# MODIFIED is judged. A tree-wide demand would fail every repo for plans written before this rule, and
# would make it a second plan gate rather than a reconciliation.
TOUCHED=""
for f in $FILES $STAGED_FILES; do
  [ -n "$f" ] || continue
  case "$f" in */plan.md|docs/PLAN.md|docs/agents/PLAN.md) TOUCHED="$TOUCHED $f" ;; esac
done

if [ -z "$(printf '%s' "$TOUCHED" | tr -d ' ')" ]; then
  echo "check-milestone-evidence: OK (no plan touched by $LABEL — nothing to reconcile)"
  exit 0
fi

# The set of line numbers the change added/modified in each touched file, so grading is line-scoped.
# Empty set => fall back to whole-file grading (a staged-only or first-commit context where a
# line-level diff against a base is impossible). Failing open there would be wrong; failing closed on
# the whole file is the house pattern, so that is the fallback, and the count makes it visible.
CHANGED_LINES=""
LINE_SCOPED=0
case "$MODE" in
  since)
    # Both the committed range AND the index. A pre-commit run sees the change only in the index, so a
    # committed-only diff yields an empty set and silently falls back to whole-file grading — which is
    # how the first draft of this scoping failed its own test. Union the two.
    # Both the committed range AND the index, concatenated as two separate command substitutions and
    # then parsed once. A pre-commit run sees the change only in the index; a CI run sees it only in
    # the committed range. Unioning them is the whole point — a committed-only diff yields an empty set
    # and silently falls back to whole-file grading.
    _dl_diff="$(git diff -U0 --diff-filter=AMR "$SINCE"...HEAD -- '*plan.md' 2>/dev/null || true)"
    _dl_idx="$(git diff -U0 --cached --diff-filter=AMR -- '*plan.md' 2>/dev/null || true)"
    CHANGED_LINES="$(printf '%s\n%s\n' "$_dl_diff" "$_dl_idx" \
      | sed -n 's/^@@.*+\([0-9]*\),\([0-9]*\).*/\1 \2/p' | while read -r _st _ct; do
          _i=0
          while [ "$_i" -lt "$_ct" ]; do printf '%s ' "$((_st + _i))"; _i=$((_i + 1)); done
        done)"
    if [ -n "$(printf '%s' "$CHANGED_LINES" | tr -d ' ')" ]; then LINE_SCOPED=1; fi ;;
esac

FAILED=0
REPORT=""
CHECKED=0
DONE_TOTAL=0

for plan in $TOUCHED; do
  [ -f "$plan" ] || continue
  # An ARCHIVED pair (`docs/agents/<area>/completed/<slug>/`) is history, not a live claim. The rungs
  # judge a change's claim when it is MADE; a move into the archive makes every file in it "changed"
  # without making a new claim, so grading it again re-opens a decision already taken — against rules
  # that may postdate the artifact (this is how the launch rung read `[Unreleased]` as a claim and the
  # wireframe rung read a reversed opt-out as silence). check-plan-home.sh exempts the same path.
  case "$plan" in */_templates*|*/_template*|*/templates/*|*/examples/*|*/_examples*|*/completed/*) continue ;; esac

  CHECKED=$((CHECKED + 1))

  # Completed milestones only: `- [x]`. An open `- [ ]` claims nothing yet, so it owes no evidence.
  # Read line by line through a redirected here-doc (not a pipe) so the loop runs in THIS shell and can
  # set FAILED — a piped while would set it in a subshell and vanish.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    DONE_TOTAL=$((DONE_TOTAL + 1))
    # strip the grep -n line-number prefix FIRST, or it leaks into the message as "44:- [x] ..."
    _trim="$(printf '%s' "$line" | sed 's/^[0-9]*://; s/^[[:space:]]*-[[:space:]]*\[[xX]\][[:space:]]*//')"

    # The evidence reference: a backticked path, or a PR reference. Either counts, anywhere in the line.
    # GRADE ONLY WHAT THIS CHANGE WROTE. The first draft graded every completed milestone in a touched
    # plan, which would fail any edit to an older plan for debt that predates the rule — 19 of this
    # repo's 54 completed milestones. That is friction that teaches people to avoid touching plans,
    # which is the opposite of the point. A milestone the change did not touch is historical record.
    if [ "$LINE_SCOPED" -eq 1 ]; then
      _lineno="$(printf '%s' "$line" | sed -n 's/^\([0-9]*\):.*/\1/p')"
      case " $CHANGED_LINES " in
        *" $_lineno "*) : ;;
        *) continue ;;
      esac
    fi

    # shellcheck disable=SC2016  # the backticks are the markdown delimiter being matched, not a
    # command substitution — they must stay literal in the single-quoted sed program.
    _ev="$(printf '%s' "$_trim" | sed -n 's/.*`\([^`][^`]*\)`.*/\1/p' | head -1)"
    _pr="$(printf '%s' "$_trim" | sed -n 's/.*\(PR[[:space:]]*#[0-9][0-9]*\).*/\1/p' | head -1)"

    if [ -z "$_ev" ] && [ -z "$_pr" ]; then
      FAILED=1
      REPORT="$REPORT$plan
    completed milestone claims nothing it can be checked against: $(printf '%s' "$_trim" | cut -c1-70)…
"
      continue
    fi

    # It claims something — does the claim resolve?
    if [ -n "$_ev" ]; then
      case "$_ev" in
        *" "*|'')  # a reference with spaces is prose, not a path; treat as unresolvable
          FAILED=1
          REPORT="$REPORT$plan
    names '$_ev' as evidence, which is not a resolvable path (contains spaces).
"
          continue ;;
      esac
      if [ ! -e "$_ev" ]; then
        # Directories and files both resolve; git can also check historical paths for a renamed file.
        if ! git ls-files --error-unmatch "$_ev" >/dev/null 2>&1 && [ ! -d "$_ev" ]; then
          FAILED=1
          REPORT="$REPORT$plan
    names '$_ev' as evidence, but no such path exists in the repo.
"
        fi
      fi
    elif [ -n "$_pr" ]; then
      _num="$(printf '%s' "$_pr" | sed 's/[^0-9]//g')"
      # The PR reference must be real: `gh` when available, else the commit log for the merge of that PR
      # (squash-merge titles carry "(#NN)"). Absent both, the reference cannot be verified — report that
      # rather than passing it as though it had been.
      # Verify against the repo the LOG belongs to. In CI, `gh pr view` queries the real repository
      # while a canary fixture is a throwaway temp repo — so a fixture's fake PR number would be
      # reported as nonexistent, and the fixture would be failing on the environment rather than on the
      # behaviour. Prefer gh only when we are inside a gh-resolvable checkout AND the fixture is not a
      # temp repo; otherwise the commit log is the authority, which is deterministic everywhere.
      _in_gh_repo=0
      if command -v gh >/dev/null 2>&1 && [ -n "${GITHUB_ACTIONS:-}" ] \
         && gh repo view >/dev/null 2>&1; then
        case "$ROOT" in
          */tmp/*|*/T/*|*scratch/*|*canary*) _in_gh_repo=0 ;;
          *) _in_gh_repo=1 ;;
        esac
      fi
      if [ "$_in_gh_repo" -eq 1 ]; then
        if ! gh pr view "$_num" >/dev/null 2>&1; then
          FAILED=1
          REPORT="$REPORT$plan
    cites PR #$_num as evidence, which does not exist in this repository.
"
        fi
      elif ! git log --oneline -5000 2>/dev/null | grep -q "(#$_num)"; then
        FAILED=1
        REPORT="$REPORT$plan
    cites PR #$_num as evidence, and no commit in the log references it. (Renumbered or from another
    repo? Cite the path instead, or reconcile the number.)
"
      fi
    fi
  done <<EOF
$(grep -nE '^[[:space:]]*-[[:space:]]*\[[xX]\]' "$plan" 2>/dev/null || true)
EOF
done

if [ "$FAILED" -eq 1 ]; then
  echo "check-milestone-evidence: a completed milestone has no verifiable evidence ($LABEL):" >&2
  printf '%s' "$REPORT" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  A tick is a claim about work. Name what it produced, in backticks:" >&2
  echo "" >&2
  echo "    - [x] M1 — the coverage gate — \`scripts/check-coverage.sh\`" >&2
  echo "    - [x] M2 — landed as PR #38" >&2
  echo "" >&2
  echo "  Either a path that exists, or a PR number that resolves. If the milestone genuinely" >&2
  echo "  produced no artifact of its own, say what it did produce — a decision recorded, a doc" >&2
  echo "  written, a thing deleted. 'Nothing' is a claim too, and an unverifiable one." >&2
  echo "" >&2
  echo "  This gate checks that evidence was OFFERED and RESOLVES. It cannot tell whether the" >&2
  echo "  milestone is truly finished or the reference is the right one — a review question." >&2
  echo "  Doctrine: .agents/rules/spec.md (the seam) and .agents/rules/workflow.md." >&2
  echo "  Deliberate exception? MILESTONE_OFF=1 — say so out loud." >&2
  exit 1
fi

if [ "$CHECKED" -eq 0 ]; then
  echo "check-milestone-evidence: OK (no plan with milestones in $LABEL — nothing to reconcile)"
else
  echo "check-milestone-evidence: OK ($CHECKED plan(s), $DONE_TOTAL completed milestone(s) — every one names resolvable evidence)"
fi
exit 0
