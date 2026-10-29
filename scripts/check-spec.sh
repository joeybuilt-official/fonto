#!/usr/bin/env sh
# check-spec.sh — the spec gate: a structural change must have a spec behind it, with its ambiguities resolved.
#
# Enforces the spec rung (.agents/rules/spec.md) mechanically, in the same spirit as the plan-home,
# docs, and algorithm gates: the rule is doctrine, and doctrine drifts.
#
# Why THIS is the checkable part of a spec: a spec's quality (are the stories independently testable? are
# the criteria measurable?) is judgement and belongs to review. Two things are not judgement, and they
# are the two that actually cost money when missed:
#
#   1. there IS a spec. Without this the rung simply does not get used — three governance plans with zero
#      acceptance scenarios is what an unchecked rung looks like.
#   2. no ambiguity was carried into the plan. `[NEEDS CLARIFICATION: …]` is legal in a DRAFT spec and
#      nowhere else. An unresolved marker that reaches implementation has already become a guess nobody
#      reviewed, so the marker is a debt with exactly two settlements: answer it, or delete the
#      requirement.
#
#   sh scripts/check-spec.sh              # git mode — diff against the merge base / HEAD~1
#   sh scripts/check-spec.sh --since SHA  # explicit diff base (CI: the PR base SHA)
#   sh scripts/check-spec.sh --staged     # staged changes only (pre-commit context)
#
# Config (all optional):
#   SPEC_OFF=1        disable entirely (deliberate exception — say so out loud)
#   SPEC_FILES=glob   override what counts as "code" (default below)
#   SPEC_GLOB=glob    override where specs live (default docs/agents/<area>/<feature>/spec.md)
#
# WHAT THIS GATE CANNOT DO — read it before trusting a green run:
#   It checks that a spec EXISTS and that no `[NEEDS CLARIFICATION: …]` survives in it. It cannot tell
#   whether the stories are genuinely independently testable, whether the acceptance scenarios are
#   concrete enough to become tests, whether the success criteria are measurable, or whether the
#   requirements are worth what they cost. Those stay review questions and must be asked explicitly in
#   the expert-review gate. A gate that passes while a requirement went unexamined is a gate measuring
#   the wrong thing.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${SPEC_OFF:-0}" = "1" ] && { echo "check-spec: disabled (SPEC_OFF=1)"; exit 0; }

# Where specs live. A spec is a SIBLING of the plan it belongs to — never a second specs/ tree, because
# check-plan-home.sh permits exactly docs/agents/<area>/<feature>/plan.md and both it and
# check-algorithm.sh glob docs/agents/*/*/. A sibling needs no new allowance in either.
SPEC_GLOB="${SPEC_GLOB:-docs/agents/*/*/spec.md}"

# What counts as a structural change. Docs/rules-only edits are exempt: a rule module, a note, or a copy
# change is not a part of the system, and demanding a spec for a typo fix is exactly the ceremony the
# rule's own scope test forbids.
#
# NOTE the exemption below is config/, not just docs/. A workflow that runs a gate, a pre-commit hook, a
# linter config or a CI template is WIRING: it changes when the gates run, never what a user can do with
# the product. Demanding a spec for "add a step to verify.yml" would be wrong for the same reason a typo
# fix is wrong — and it would have mis-classified this file's own adoption, since every `.yml` under
# `.github/` matched the suffix rule below.
CODE_RE='(^|/)(src|apps|packages|lib|scripts|e2e|infra|migrations)/|\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|swift|c|cc|cpp|h|hpp|sql|sh|ps1|tf|yml|yaml)$'
[ -n "${SPEC_FILES:-}" ] && CODE_RE="$SPEC_FILES"

# Wiring, not system: CI workflows, templates, hook and tool config. Exempt even though the suffix rule
# above would otherwise call them code. Kept as its own pattern so the exemption is auditable rather
# than buried in a negative lookahead nobody can read.
CONFIG_RE='^\.github/|(^|/)\.pre-commit|(^|/)(tsconfig|eslint\.config|vite\.config|playwright\.config|jest\.config|vitest\.config|docker-compose)[^/]*$|(^|/)\.agents/'

MODE="git"
SINCE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --since)
    MODE="since"
    SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-spec: refusing --since with an empty base SHA — set SPEC_OFF=1 for a deliberate" >&2
      echo "  skip instead of silently checking nothing." >&2
      exit 2
    fi
    ;;
  "")       MODE="git" ;;
  *) echo "check-spec: unknown argument '$1'" >&2; exit 2 ;;
esac

# --- collect the changed files ----------------------------------------------
# Every mode must produce a real diff. If a base does not resolve (a shallow CI checkout, a wrong ref, a
# fixture with no history), the diff comes back EMPTY and the gate reports OK — passing for the wrong
# reason, which is indistinguishable from the gate working. So verify the base resolves and refuse
# loudly instead of quietly checking nothing.
diff_files() {
  _base="$1"
  if ! git rev-parse -q --verify "${_base}^{commit}" >/dev/null 2>&1; then
    echo "check-spec: diff base '$_base' does not resolve in this checkout (shallow clone or wrong" >&2
    echo "  ref). Pass the PR base SHA explicitly, or set SPEC_OFF=1 for a deliberate skip." >&2
    exit 2
  fi
  git diff --name-only --diff-filter=ACMR "$_base"...HEAD 2>/dev/null || true
}

case "$MODE" in
  staged)
    FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
    LABEL="staged change"
    DIFF_BASE=""
    ;;
  since)
    FILES="$(diff_files "$SINCE")"
    LABEL="change since $SINCE"
    DIFF_BASE="$SINCE"
    ;;
  git)
    if [ -n "${GITHUB_BASE_REF:-}" ]; then
      FILES="$(diff_files "origin/${GITHUB_BASE_REF}")"
      LABEL="change vs origin/${GITHUB_BASE_REF}"
      DIFF_BASE="origin/${GITHUB_BASE_REF}"
    elif git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then
      FILES="$(git diff --name-only --diff-filter=ACMR HEAD~1...HEAD 2>/dev/null || true)"
      LABEL="change in HEAD"
      DIFF_BASE="HEAD~1"
    else
      # No parent commit (a fixture's first commit, or a depth-1 checkout). Say so rather than reporting a
      # clean result about a comparison that never happened.
      echo "check-spec: no parent commit to diff against (first commit or shallow checkout)." >&2
      echo "  Pass --since <sha>, or set SPEC_OFF=1 for a deliberate skip." >&2
      exit 2
    fi
    ;;
esac

if [ -z "$FILES" ]; then
  echo "check-spec: OK (no changed files)"
  exit 0
fi

# --- is this change structural? ---------------------------------------------
STRUCTURAL=0
for f in $FILES; do
  [ -n "$f" ] || continue
  case "$f" in docs/*|*.md|*/completed/*) continue ;; esac
  # Wiring is exempt even though it carries a code suffix — see CONFIG_RE.
  printf '%s' "$f" | grep -Eq "$CONFIG_RE" && continue
  printf '%s' "$f" | grep -Eq "$CODE_RE" || continue
  STRUCTURAL=1
  break
done

if [ "$STRUCTURAL" -eq 0 ]; then
  echo "check-spec: OK (docs-only / no structural change in $LABEL)"
  exit 0
fi

# --- is there a spec at all? -------------------------------------------------
# The gate must be able to OBSERVE ITS OWN REMEDY: the spec IS the remedy, so this never blocks a write
# to docs/** (exempted above) and a spec that appears in the same change satisfies it immediately.
SPECS=""
add_spec() { [ -f "$1" ] || return 0; case " $SPECS " in *" $1 "*) ;; *) SPECS="$SPECS $1" ;; esac; }

# 1. a spec already tracked in the tree (the common case: it was written, then the code followed)
for g in $SPEC_GLOB; do
  for p in $g; do add_spec "$p"; done
done
# 2. a spec ADDED by this change but not yet tracked (unstaged/uncommitted — pre-commit context)
for f in $(git diff --cached --name-only --diff-filter=A 2>/dev/null || true) \
         $(git diff --name-only --diff-filter=A 2>/dev/null || true); do
  case "$f" in */spec.md) add_spec "$f" ;; esac
done

if [ -z "$SPECS" ]; then
  echo "check-spec: structural change in $LABEL has no spec." >&2
  echo "  no spec found under: $SPEC_GLOB" >&2
  echo "" >&2
  echo "  A structural change starts from a spec, not a plan — what a user can DO after this ships," >&2
  echo "  and how we will know it worked:" >&2
  echo "" >&2
  echo "    1. cp docs/agents/_templates/spec.md docs/agents/<area>/<slug>/spec.md" >&2
  echo "    2. write the prioritized user stories (each with its own independent test) and the" >&2
  echo "       Given/When/Then acceptance scenarios" >&2
  echo "    3. resolve every [NEEDS CLARIFICATION: …] — answer it, or delete the requirement" >&2
  echo "    4. re-run this gate — it passes the moment the spec exists with no marker left" >&2
  echo "" >&2
  echo "  Routine work inside an existing pattern (typo, copy change, behavior-preserving refactor," >&2
  echo "  a bug fix whose acceptance criterion is the existing behavior) does not need a spec." >&2
  echo "  Doctrine: .agents/rules/spec.md. Deliberate exception? SPEC_OFF=1 — say that you used it." >&2
  exit 1
fi

# --- do any of them still carry an unresolved ambiguity? ---------------------
# The marker is legal in a DRAFT spec and nowhere else — but the gate must not match the convention
# METASYNTTAX. A rule module explaining the marker, the spec template documenting it, and this script's
# own refusal text all quote `[NEEDS CLARIFICATION: …]` or `[NEEDS CLARIFICATION: <question>]` in prose,
# and a pattern-matching gate that matches its own documentation reports every correct repo as broken —
# the always-red failure the kit's placeholder scan already hit once (scripts/panoply.sh → "Only
# ADAPT-TIME tokens count"). An UNRESOLVED marker is one carrying real content; a metasyntax form
# (empty, `…`, `<…>`, `TODO`, `TBD`, `...`) is prose discussing the convention and is not counted.
#
# SELF_EXCLUDE mirrors the same rule in the kit: never scan the gate's own sources, nor the template and
# rule module that exist to document the convention.
SELF_EXCLUDE="scripts/check-spec.sh scripts/check-spec.test.sh .agents/rules/spec.md docs/agents/_templates/spec.md"
_is_metasyntax() {
  _body="$1"
  # strip surrounding whitespace
  _body="$(printf '%s' "$_body" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$_body" ] && return 0
  case "$_body" in
    "…"|"..."|"<"*">"|"["*"]"|"TODO"|"TBD"|"todo"|"tbd"|"?"*) return 0 ;;
  esac
  return 1
}

UNRESOLVED=""
for p in $SPECS; do
  _skip=0
  for _ex in $SELF_EXCLUDE; do
    [ "$p" = "$_ex" ] && _skip=1
  done
  [ "$_skip" -eq 1 ] && continue

  # Every marker on its own line; count only the ones carrying real content.
  _hits=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _body="$(printf '%s' "$line" | sed -n 's/.*\[NEEDS[[:space:]]*CLARIFICATION[:]\([^]]*\)\].*/\1/p')"
    [ -n "$_body" ] || continue
    if ! _is_metasyntax "$_body"; then
      _hits="$_hits$line
"
    fi
  done <<EOF
$(grep -Ei '\[NEEDS[[:space:]]+CLARIFICATION' "$p" || true)
EOF
  if [ -n "$_hits" ]; then
    UNRESOLVED="$UNRESOLVED$p
"
    UNRESOLVED="$UNRESOLVED$(printf '%s' "$_hits" | sed 's/^[[:space:]]*/    /')
"
  fi
done

if [ -n "$UNRESOLVED" ]; then
  echo "check-spec: unresolved ambiguity carried toward the plan ($LABEL):" >&2
  printf '%s' "$UNRESOLVED" >&2
  echo "" >&2
  echo "  [NEEDS CLARIFICATION: …] belongs in a DRAFT spec only. Each marker has exactly two legal" >&2
  echo "  settlements — answer it, or delete the requirement. Do NOT resolve one by choosing a" >&2
  echo "  plausible value: an ambiguity that reaches the plan has already become a guess nobody" >&2
  echo "  reviewed, and inventing the answer is the fabrication the kit forbids everywhere else." >&2
  echo "" >&2
  echo "  When the answer is genuinely the owner's, ask with two options plus a recommendation" >&2
  echo "  (.agents/rules/quality-bar.md). Doctrine: .agents/rules/spec.md." >&2
  exit 1
fi

# --- does the spec record the simulated user interviews? ---------------------
# The spec rung requires four user personas to be interviewed (simulated) before UI/UX and
# functionality decisions are made (`.agents/rules/spec.md` item 7). Like the `Deletion candidates`
# section check-algorithm.sh enforces, this is the ONE part of that requirement that is not judgement:
# the section either exists or it does not. Whether the interviews are GOOD — whether they surfaced
# anything real, whether the design decisions genuinely follow — is review's question, and this gate
# says so below rather than pretending to judge it.
#
# SCOPE — this is the part that cost a rewrite. The check applies to specs THIS CHANGE ADDED OR
# MODIFIED, never to every spec in the tree. Requiring it of a pre-existing spec would fail a repo for
# a spec it wrote before the rule existed, and would demand "user personas" of the kit's own internal
# governance specs (which are about the kit, not about a product with users). Same scoping rule the
# expert-review gate needed, for the same reason: a gate that measures the tree instead of the change
# reports the repo's history, not the change under review.
#
# The heading is matched LOOSELY (case-insensitive, either word order, or the explicit n/a form), the
# same way check-algorithm.sh matches its section heading: a gate that demands one exact string is a
# gate that fails a repo for phrasing.
#
# Escape hatches, in the kit's usual spirit: a project with no user-facing surface says so explicitly
# (`n/a — no user-facing surface`), and SPEC_INTERVIEWS_OFF=1 records a deliberate skip.
INTERVIEWS_OFF="${SPEC_INTERVIEWS_OFF:-0}"
_spec_has_interviews() {
  _f="$1"
  # Accept the deliberate n/a form: a pure library or cron job has no personas to interview.
  grep -qiE 'n/a[^a-z0-9]*no user-facing surface' "$_f" && return 0
  # Accept a heading naming user interviews (either word order) — the template's own heading and any
  # reasonable paraphrase of it.
  grep -qiE '^#+[[:space:]]*.*(user|persona).*(interview)|^#+[[:space:]]*.*(interview).*(user|persona)' "$_f" && return 0
  return 1
}

if [ "$INTERVIEWS_OFF" != "1" ]; then
  # Which specs did THIS change touch? A spec the change ADDED (diff-filter A) or MODIFIED (M). This is
  # the change-scoping that keeps the gate about the change rather than about the whole tree.
  TOUCHED_SPECS=""
  for f in $(git diff --name-only --diff-filter=AM "$DIFF_BASE"...HEAD 2>/dev/null || true); do
    case "$f" in */spec.md) TOUCHED_SPECS="$TOUCHED_SPECS $f" ;; esac
  done
  # In --staged mode the working index is the change; include staged spec additions/modifications.
  for f in $(git diff --cached --name-only --diff-filter=AM 2>/dev/null || true); do
    case "$f" in */spec.md) TOUCHED_SPECS="$TOUCHED_SPECS $f" ;; esac
  done

  MISSING_INTERVIEWS=""
  for p in $TOUCHED_SPECS; do
    [ -n "$p" ] || continue
    _skip=0
    for _ex in $SELF_EXCLUDE; do
      [ "$p" = "$_ex" ] && _skip=1
    done
    [ "$_skip" -eq 1 ] && continue
    # A spec the change DELETED is not our problem; only a spec that exists now.
    [ -f "$p" ] || continue
    _spec_has_interviews "$p" || MISSING_INTERVIEWS="$MISSING_INTERVIEWS$p
"
  done

  if [ -n "$MISSING_INTERVIEWS" ]; then
    echo "check-spec: spec does not record the simulated user interviews ($LABEL):" >&2
    printf '%s' "$MISSING_INTERVIEWS" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Before any UI/UX or functionality decision, the spec interviews FOUR of this project's" >&2
    echo "  own user personas (domain roles — a producer, a gaffer — not software roles) and records" >&2
    echo "  what each surfaced and which decision it changed. The interviews are the INPUT to design," >&2
    echo "  not a write-up after it." >&2
    echo "" >&2
    echo "  Add a section (see docs/agents/_templates/spec.md → 'User interviews (simulated, 4 personas)'):" >&2
    echo "    ## User interviews (simulated, 4 personas)" >&2
    echo "    | # | Persona | What they were asked | What they said (SIMULATED) | Decision it changed |" >&2
    echo "" >&2
    echo "  State plainly they are SIMULATED role-plays — never a real quote from a real person." >&2
    echo "  No user-facing surface at all (a library, a cron job)? Write exactly:" >&2
    echo "    n/a — no user-facing surface, so no personas to interview" >&2
    echo "" >&2
    echo "  This gate checks the section EXISTS. Whether the interviews are good, and whether the" >&2
    echo "  decisions genuinely follow from them, is review's question — ask it there." >&2
    echo "  Doctrine: .agents/rules/spec.md. Deliberate exception? SPEC_INTERVIEWS_OFF=1 — say so." >&2
    exit 1
  fi
fi

echo "check-spec: OK (spec present, no unresolved ambiguity, interviews recorded in $LABEL)"
exit 0
