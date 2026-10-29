#!/usr/bin/env sh
# check-milestone-evidence.test.sh — the plan→code reconciliation canary.
#
# Both directions: a completed milestone naming real evidence passes; one claiming nothing is refused.
# Plus the adversarial cases a plausible-but-wrong implementation fails: a reference to a path that does
# not exist, a PR number from nowhere, an OPEN milestone (which claims nothing yet), the templates
# exemption, and the escape hatch.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-milestone-evidence.sh"
TMP="${TMPDIR:-/tmp}/milestone-canary.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

mkrepo() {
  d="$TMP/$1"
  mkdir -p "$d/scripts"
  git -C "$d" init -q
  git -C "$d" config user.email c@e.invalid
  git -C "$d" config user.name c
  git -C "$d" config commit.gpgsign false
  git -C "$d" symbolic-ref HEAD refs/heads/main
  cp "$GATE" "$d/scripts/check-milestone-evidence.sh"
  printf 'x\n' > "$d/README.md"
  printf 'real artifact\n' > "$d/thing.ts"
  git -C "$d" add -A
  git -C "$d" -c user.email=c@e.invalid -c user.name=c -c commit.gpgsign=false commit -qm base
  printf '%s' "$d"
}

cmit() {
  git -C "$1" add -A
  git -C "$1" -c user.email=c@e.invalid -c user.name=c -c commit.gpgsign=false commit -qm "${2:-c}"
}

gate_class() {
  d="$1"; base="$2"
  out="$( ( cd "$d" && sh scripts/check-milestone-evidence.sh --since "$base" ) 2>&1 )" && { printf 'ok'; return 0; }
  case "$out" in
    *"claims nothing it can be checked against"*) printf 'fail-noevidence' ;;
    *"no such path exists"*) printf 'fail-badpath' ;;
    *"no commit in the log references it"*|*"does not exist in this repository"*) printf 'fail-badpr' ;;
    *"not a resolvable path"*) printf 'fail-notpath' ;;
    *"does not resolve"*) printf 'fail-unresolvable' ;;
    *) printf 'fail-errored' ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# case 1: a completed milestone naming a REAL path → PASS (positive control; without this the gate
# could be always-red and every other case would look like success)
r="$(mkrepo pass-real-path)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
# shellcheck disable=SC2016  # markdown backticks inside the fixture text
printf '# Plan\n\n## Milestones\n- [x] M1 — add the thing — `thing.ts`\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "real evidence"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a completed milestone naming a real path passes"
else bad "a completed milestone with real evidence was refused (got '$rc')"; fi

# case 2: THE ADVERSARIAL CASE — a completed milestone with NO evidence → REFUSED
r="$(mkrepo fail-noevidence)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
printf '# Plan\n\n## Milestones\n- [x] M1 — added the thing, all done\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "bare claim"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "fail-noevidence" ]; then ok "a completed milestone claiming nothing is refused"
else bad "a bare completed milestone was accepted (got '$rc')"; fi

# case 3: evidence names a path that does NOT exist → REFUSED. This is the whole point: a reference
# that resolves nowhere is the same as no reference.
r="$(mkrepo fail-badpath)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
# shellcheck disable=SC2016  # markdown backticks inside the fixture text
printf '# Plan\n\n## Milestones\n- [x] M1 — add it — `src/does-not-exist.ts`\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "bogus path"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "fail-badpath" ]; then ok "evidence naming a nonexistent path is refused"
else bad "a nonexistent path reference was accepted (got '$rc')"; fi

# case 4: an OPEN milestone claims nothing yet → PASS (only completed milestones owe evidence)
r="$(mkrepo pass-open)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
# shellcheck disable=SC2016  # markdown backticks inside the fixture text
printf '# Plan\n\n## Milestones\n- [ ] M1 — not started yet\n- [x] M0 — scaffold — `thing.ts`\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "open + one done"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "an open milestone owes no evidence (it claims nothing yet)"
else bad "an open milestone was wrongly required to have evidence (got '$rc')"; fi

# case 5: a PR reference that does not resolve → REFUSED
r="$(mkrepo fail-badpr)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
printf '# Plan\n\n## Milestones\n- [x] M1 — landed as PR #99999\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "bogus PR"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "fail-badpr" ]; then ok "a PR reference that resolves to nothing is refused"
else bad "a nonexistent PR reference was accepted (got '$rc')"; fi

# case 6: a PR reference that DOES resolve (squash-merge style commit) → PASS
r="$(mkrepo pass-real-pr)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
printf '# Plan\n\n## Milestones\n- [x] M1 — landed as PR #42\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "feat: the thing (#42)"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a PR reference matching a commit is accepted"
else bad "a resolvable PR reference was refused (got '$rc')"; fi

# case 7: _templates/ scaffolding is exempt
r="$(mkrepo pass-templates)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/_templates"
printf '# Plan template\n\n## Milestones\n- [x] M1 — <example, no evidence needed>\n' > "$r/docs/agents/_templates/plan.md"
cmit "$r" "template plan"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "_templates/ scaffolding is exempt"
else bad "a template plan was judged as a live plan (got '$rc')"; fi

# case 8: a change touching no plan defers explicitly (not this gate's case)
r="$(mkrepo pass-noplan)"; base="$(git -C "$r" rev-parse HEAD)"
printf 'code\n' > "$r/other.ts"
cmit "$r" "code only"
out="$( cd "$r" && sh scripts/check-milestone-evidence.sh --since "$base" )"
if printf '%s' "$out" | grep -q 'no plan touched'; then
  ok "a change touching no plan defers explicitly"
else bad "the gate did not defer explicitly when no plan was touched" "$out"; fi

# case 9: the escape hatch disarms the gate
r="$(mkrepo pass-off-switch)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
printf '# Plan\n\n## Milestones\n- [x] M1 — bare claim\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "bare, hatch used"
if ( cd "$r" && MILESTONE_OFF=1 sh scripts/check-milestone-evidence.sh --since "$base" ) >/dev/null 2>&1; then
  ok "MILESTONE_OFF=1 disarms the gate"
else bad "MILESTONE_OFF=1 did not disarm the gate"; fi

# case 10: --since with an empty base refuses rather than checking nothing
r="$(mkrepo pass-empty-base)"
if ( cd "$r" && sh scripts/check-milestone-evidence.sh --since "" ) >/dev/null 2>&1; then
  bad "--since with an empty base was accepted"
else ok "--since with an empty base refuses instead of checking nothing"; fi

# case 11: the pass message reports HOW MANY plans/milestones were checked, so "checked 3" and
# "checked nothing" cannot look alike
r="$(mkrepo pass-count)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
# shellcheck disable=SC2016  # markdown backticks inside the fixture text
printf '# Plan\n\n## Milestones\n- [x] M1 — a — `thing.ts`\n- [x] M2 — b — `README.md`\n' > "$r/docs/agents/core/thing/plan.md"
cmit "$r" "two done"
out="$( cd "$r" && sh scripts/check-milestone-evidence.sh --since "$base" )"
if printf '%s' "$out" | grep -q '2 completed milestone'; then
  ok "the pass message reports how many milestones it checked"
else bad "the pass message does not report a count" "$out"; fi


# case 12: an ARCHIVED plan is history — a completed milestone naming a path that does not exist must not
# be re-graded once the plan sits under `<area>/completed/`. Case 2 refuses exactly this live.
r="$(mkrepo pass-archived)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/completed/thing" "$r/src"
# shellcheck disable=SC2016  # markdown backticks inside the fixture text
printf '# Plan\n\n- [x] **M1 — the thing** — evidence: `does/not/exist.md`\n' > "$r/docs/agents/core/completed/thing/plan.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "archived plan, unresolvable evidence"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "an archived plan is not re-graded for its milestone evidence"
else bad "an archived plan was re-graded (got '$rc')"; fi

printf '\ncheck-milestone-evidence canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
