#!/usr/bin/env sh
# check-coverage.test.sh — the canary for the spec→plan coverage rivet.
#
# A gate that cannot go red is not evidence. This asserts BOTH directions — a covered pair passes, an
# uncovered requirement is refused — plus the adversarial cases that a plausible-but-wrong
# implementation would fail: a plan citing a requirement that does not exist, a plan with no coverage
# table at all, a non-structural change that must be exempt, and the escape hatch actually working.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-coverage.sh"
TMP="${TMPDIR:-/tmp}/coverage-canary.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

cmit() {
  git -C "$1" add -A
  git -C "$1" -c user.email=canary@example.invalid -c user.name=canary \
    -c commit.gpgsign=false commit -qm "${2:-c}" >/dev/null 2>&1
}

# A scratch repo carrying the gate and a base commit.
mkrepo() {
  d="$TMP/$1"
  mkdir -p "$d/scripts"
  git -C "$d" init -q 2>/dev/null || { printf 'cannot init git repo\n' >&2; exit 2; }
  git -C "$d" config user.email canary@example.invalid
  git -C "$d" config user.name canary
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.hooksPath /dev/null
  git -C "$d" symbolic-ref HEAD refs/heads/main
  cp "$GATE" "$d/scripts/check-coverage.sh"
  printf 'base\n' > "$d/README.md"
  cmit "$d" base
  printf '%s' "$d"
}

root_sha() { git -C "$1" rev-parse HEAD; }

# Run the gate in $1 since base $2; print a classification, never the raw exit code alone.
gate_at() {
  d="$1"; base="$2"
  out="$( ( cd "$d" && sh scripts/check-coverage.sh --since "$base" ) 2>&1 )" && { printf 'ok'; return 0; }
  case "$out" in
    *"requirements with NO milestone"*) printf 'fail-uncovered' ;;
    *"cites requirements that do not exist"*) printf 'fail-dangling' ;;
    *"carries no '## Spec coverage'"*) printf 'fail-nosection' ;;
    *"does not resolve"*|*"no parent commit"*) printf 'fail-unresolvable' ;;
    *) printf 'fail-errored' ;;
  esac
}

# Fixture helpers ---------------------------------------------------------------------------
mkspec() {
  cat > "$1" <<SPEC
# Spec: thing

## Requirements
- **FR-001**: The system MUST do the first thing.
- **FR-002**: The system MUST do the second thing.
- **FR-003**: The system MUST do the third thing.
SPEC
}

mkplan() {
  # $1 = path, $2 = the coverage rows (already formatted, one per line)
  {
    printf '# Plan: thing\n\n## Deletion candidates\n\n'
    printf '| Candidate | Removed? | Why |\n|---|---|---|\n| nothing | no | argued empty |\n\n'
    printf '## Spec coverage\n\n| Requirement | Milestone |\n|---|---|\n'
    printf '%s\n' "$2"
  } > "$1"
}

# ---------------------------------------------------------------------------------------------
# case 1: a fully covered pair → PASS (positive control; without this the gate could be always-red)
r="$(mkrepo pass-covered)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
mkspec "$r/docs/agents/core/thing/spec.md"
mkplan "$r/docs/agents/core/thing/plan.md" "| FR-001 | M1 |
| FR-002 | M2 |
| FR-003 | M3 |"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x with full coverage"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a spec whose every requirement is covered passes"
else bad "a covered pair was not accepted (got '$rc')"; fi

# case 2: THE ADVERSARIAL CASE — one requirement left uncovered → REFUSED, naming it
r="$(mkrepo fail-uncovered)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
mkspec "$r/docs/agents/core/thing/spec.md"
mkplan "$r/docs/agents/core/thing/plan.md" "| FR-001 | M1 |
| FR-002 | M2 |"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x missing FR-003"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "fail-uncovered" ]; then ok "an uncovered requirement is refused"
else bad "an uncovered requirement was not refused (got '$rc')"; fi
if ( cd "$r" && sh scripts/check-coverage.sh --since "$base" ) 2>&1 | grep -q 'FR-003'; then
  ok "the refusal names the uncovered requirement"
else bad "the refusal does not name which requirement is uncovered"; fi

# case 3: a plan citing a requirement the spec never declared → REFUSED (dangling)
r="$(mkrepo fail-dangling)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
mkspec "$r/docs/agents/core/thing/spec.md"
mkplan "$r/docs/agents/core/thing/plan.md" "| FR-001 | M1 |
| FR-002 | M2 |
| FR-003 | M3 |
| FR-099 | M4 |"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x with a dangling citation"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "fail-dangling" ]; then ok "a plan citing a nonexistent requirement is refused"
else bad "a dangling citation was not refused (got '$rc')"; fi

# case 4: a plan with no coverage table at all → REFUSED, and the refusal names the remedy
r="$(mkrepo fail-nosection)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
mkspec "$r/docs/agents/core/thing/spec.md"
printf '# Plan: thing\n\n## Deletion candidates\n\n| C | R | W |\n|---|---|---|\n| x | no | y |\n' > "$r/docs/agents/core/thing/plan.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x with no coverage table"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "fail-nosection" ]; then ok "a plan with no coverage table is refused"
else bad "a plan with no coverage table was not refused (got '$rc')"; fi

# case 5: a docs-only change is EXEMPT — the scope test the rule itself states
r="$(mkrepo pass-docs-only)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing"
mkspec "$r/docs/agents/core/thing/spec.md"
mkplan "$r/docs/agents/core/thing/plan.md" "| FR-001 | M1 |"
printf 'notes\n' > "$r/NOTES.md"
cmit "$r" "docs: notes"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a docs-only change needs no coverage (scope test)"
else bad "a docs-only change was demanded coverage (got '$rc')"; fi

# case 6: the escape hatch actually disarms the gate — an escape that does not work is a documented lie
r="$(mkrepo pass-off-switch)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
mkspec "$r/docs/agents/core/thing/spec.md"
mkplan "$r/docs/agents/core/thing/plan.md" "| FR-001 | M1 |"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x uncovered, but COVERAGE_OFF"
if ( cd "$r" && COVERAGE_OFF=1 sh scripts/check-coverage.sh --since "$base" ) >/dev/null 2>&1; then
  ok "COVERAGE_OFF=1 disarms the gate"
else bad "COVERAGE_OFF=1 did not disarm the gate"; fi

# case 7: --since with an empty base refuses rather than checking nothing (fail loud, never fail open)
r="$(mkrepo pass-empty-base)"
if ( cd "$r" && sh scripts/check-coverage.sh --since "" ) >/dev/null 2>&1; then
  bad "--since with an empty base was accepted"
else ok "--since with an empty base refuses instead of checking nothing"; fi

# case 8: multi-milestone citation is honoured (FR-013 -> "M1, M4, M5" must count as covered once)
r="$(mkrepo pass-multi-milestone)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
mkspec "$r/docs/agents/core/thing/spec.md"
mkplan "$r/docs/agents/core/thing/plan.md" "| FR-001 | M1 |
| FR-002 | M1, M4, M5 |
| FR-003 | M6 |"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a requirement cited by several milestones counts as covered"
else bad "a multi-milestone citation was not accepted (got '$rc')"; fi

# case 9b: _templates/ is scaffolding, never a live pair — the kit's own templates must not fail the
# gate. Found in the wild: the gate joined docs/agents/_templates/spec.md to its sibling plan.md and
# reported the kit's own scaffolding as uncovered requirements.
r="$(mkrepo pass-templates-exempt)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/_templates" "$r/src"
printf '# Spec template\n\n- **FR-001**: a.\n- **FR-002**: b.\n- **FR-003**: c.\n' > "$r/docs/agents/_templates/spec.md"
printf '# Plan template\n\n## Spec coverage\n\n| Requirement | Milestone |\n|---|---|\n| FR-001 | M1 |\n' > "$r/docs/agents/_templates/plan.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "_templates/ scaffolding is exempt (not joined as a live pair)"
else bad "the kit's own templates were judged as a live pair (got '$rc')"; fi

# case 9: guide/template prose quoting the convention must not be mistaken for a pair.
# The gate requires BOTH spec.md and plan.md present in the same folder — documentation alone is not a
# joinable pair, and a gate that matched its own docs would report every repo broken.
r="$(mkrepo pass-docs-only-pair)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/_templates" "$r/src"
printf '# Spec template\n\n- **FR-001**: <requirement>.\n' > "$r/docs/agents/_templates/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "feat: x"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a template spec with no sibling plan is not judged as a pair"
else bad "a template spec was judged as a live pair (got '$rc')"; fi


# case 10: an ARCHIVED pair is history — the archive move must not re-grade it. The same disagreement
# that case 2 refuses live must be skipped once the pair sits under `<area>/completed/`.
r="$(mkrepo pass-archived)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/agents/core/completed/thing" "$r/src"
mkspec "$r/docs/agents/core/completed/thing/spec.md"
mkplan "$r/docs/agents/core/completed/thing/plan.md" "| FR-001 | M1 |"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "archived pair with uncovered requirements"
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "an archived pair is not re-graded by the archive move"
else bad "an archived pair was graded as if it were live (got '$rc')"; fi

printf '\ncheck-coverage canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
