#!/usr/bin/env sh
# check-wireframe.test.sh — the wireframe presence gate's canary.
#
# A gate that cannot go red is not evidence. Both directions are asserted: a user-facing change WITH
# the artifact passes, one WITHOUT is refused. Plus the adversarial cases a plausible-but-wrong
# implementation fails: a bare `n/a` with no reason, a NEGATIVE spec that merely mentions the word
# "screen", the templates exemption, the escape hatch, and an empty `--since`.
#
# Every fixture is BUILT in a temp dir and stated directly, never sourced from a moving ref — the
# gate-integrity lesson about fixtures that test the ref instead of the behaviour.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-wireframe.sh"
TMP="${TMPDIR:-/tmp}/wireframe-canary.$$"
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
  cp "$GATE" "$d/scripts/check-wireframe.sh"
  printf 'x\n' > "$d/README.md"
  git -C "$d" add -A
  git -C "$d" -c user.email=c@e.invalid -c user.name=c -c commit.gpgsign=false commit -qm base
  printf '%s' "$d"
}

cmit() {
  git -C "$1" add -A
  git -C "$1" -c user.email=c@e.invalid -c user.name=c -c commit.gpgsign=false commit -qm "${2:-c}"
}

# classify the gate's verdict, never just the exit code
gate_class() {
  d="$1"; base="$2"
  out="$( ( cd "$d" && sh scripts/check-wireframe.sh --since "$base" ) 2>&1 )" && { printf 'ok'; return 0; }
  case "$out" in
    # case-insensitive: the gate prints "NO reason" in caps for emphasis, and a classifier that
    # greps the wrong case reports the wrong reason — the test lying about the gate, not vice versa.
    *"no reason"*|*"NO reason"*) printf 'fail-noreason' ;;
    *"has a user-facing surface but no"*) printf 'fail-nowireframe' ;;
    *"has no"*"interviews.md"*) printf 'fail-nointerviews' ;;
    *"does not resolve"*) printf 'fail-unresolvable' ;;
    *) printf 'fail-errored' ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# case 1: a user-facing change WITH wireframe + interviews → PASS (positive control; without this
# the gate could simply be always-red and every other case would look like success)
r="$(mkrepo pass-with-artifacts)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing/wireframe" "$r/src"
printf '# Spec\n\n## Requirements\n- **FR-001**: the user sees a screen listing tasks.\n' > "$r/docs/agents/core/thing/spec.md"
printf '<html></html>\n' > "$r/docs/agents/core/thing/wireframe/index.html"
printf '# Interviews\n\n| Persona | Simulated? | What surfaced | Changed |\n|---|---|---|---|\n| ops | SIMULATED | x | the list layout |\n' > "$r/docs/agents/core/thing/interviews.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "user-facing with artifacts"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a user-facing change with wireframe + interviews passes"
else bad "a complete user-facing change was not accepted (got '$rc')"; fi

# case 2: THE ADVERSARIAL CASE — user-facing, no wireframe → REFUSED
r="$(mkrepo fail-nowireframe)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
printf '# Spec\n\n## Requirements\n- **FR-001**: the user sees a screen listing tasks.\n' > "$r/docs/agents/core/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "user-facing, no wireframe"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "fail-nowireframe" ]; then ok "a user-facing change with no wireframe is refused"
else bad "a user-facing change with no wireframe was not refused (got '$rc')"; fi

# case 3: wireframe present but NO interviews → REFUSED (a wireframe nobody interviewed)
r="$(mkrepo fail-nointerviews)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing/wireframe" "$r/src"
printf '# Spec\n\n- **FR-001**: the user sees a screen.\n' > "$r/docs/agents/core/thing/spec.md"
printf '<html></html>\n' > "$r/docs/agents/core/thing/wireframe/index.html"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "wireframe, no interviews"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "fail-nointerviews" ]; then ok "a wireframe with no interviews is refused"
else bad "a wireframe with no interviews was not refused (got '$rc')"; fi

# case 4: a REASONED n/a → PASS. The rung does not apply, and the skip is written down.
r="$(mkrepo pass-reasoned-na)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
printf '# Spec\n\n- **FR-001**: a migration runner.\n\nWireframe: n/a — no user-facing surface; this is a database tool.\n' > "$r/docs/agents/core/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "reasoned n/a"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a reasoned n/a passes"
else bad "a reasoned n/a was refused (got '$rc')"; fi

# case 5: a BARE n/a with no reason → REFUSED. This is what stops the exemption becoming a rubber stamp.
r="$(mkrepo fail-noreason)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
printf '# Spec\n\n- **FR-001**: a migration runner.\n\nWireframe: n/a\n' > "$r/docs/agents/core/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "bare n/a"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "fail-noreason" ]; then ok "a bare n/a with no reason is refused"
else bad "a bare n/a was accepted (got '$rc')"; fi

# case 6: a NEGATIVE spec that merely contains the word "screen" → PASS. Vocabulary cannot tell a
# disclaimer from a requirement, so an explicit reasoned n/a must win over the keyword fallback.
r="$(mkrepo pass-negative-spec)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
printf '# Spec\n\n- **FR-001**: internal CLI. There is no screen and no page in this tool.\n\nWireframe: n/a — no user-facing surface.\n' > "$r/docs/agents/core/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "negative spec"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a spec declining the rung is not dragged in by a keyword match"
else bad "a negative spec was wrongly required to have a wireframe (got '$rc')"; fi

# case 7: _templates/ scaffolding is not a live spec — the exemption the coverage gate needed. A spec
# and its siblings under _templates/ must never fail the kit's own repo.
r="$(mkrepo pass-templates)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/_templates" "$r/src"
printf '# Spec template\n\n- **FR-001**: the user sees a screen.\n' > "$r/docs/agents/_templates/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "template spec"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "_templates/ scaffolding is exempt"
else bad "the kit's own templates were required to have a wireframe (got '$rc')"; fi

# case 8: a docs-only change is EXEMPT — the scope test the rule itself states
r="$(mkrepo pass-docs-only)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing"
printf '# Spec\n\n- **FR-001**: the user sees a screen.\n' > "$r/docs/agents/core/thing/spec.md"
cmit "$r" "docs only"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a docs-only change needs no wireframe (scope test)"
else bad "a docs-only change was demanded a wireframe (got '$rc')"; fi

# case 9: the escape hatch actually disarms the gate
r="$(mkrepo pass-off-switch)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
printf '# Spec\n\n- **FR-001**: the user sees a screen.\n' > "$r/docs/agents/core/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "no wireframe, hatch used"
if ( cd "$r" && WIREFRAME_OFF=1 sh scripts/check-wireframe.sh --since "$base" ) >/dev/null 2>&1; then
  ok "WIREFRAME_OFF=1 disarms the gate"
else bad "WIREFRAME_OFF=1 did not disarm the gate"; fi

# case 10: --since with an empty base refuses rather than checking nothing (never fail open)
r="$(mkrepo pass-empty-base)"
if ( cd "$r" && sh scripts/check-wireframe.sh --since "" ) >/dev/null 2>&1; then
  bad "--since with an empty base was accepted"
else ok "--since with an empty base refuses instead of checking nothing"; fi

# case 11: the gate reports HOW MANY it checked, so "checked 2" and "checked nothing" cannot look alike
r="$(mkrepo pass-count)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing/wireframe" "$r/src"
printf '# Spec\n\n- **FR-001**: the user sees a screen.\n' > "$r/docs/agents/core/thing/spec.md"
printf '<html></html>\n' > "$r/docs/agents/core/thing/wireframe/index.html"
printf '# Interviews\n\n| P | S | W | C |\n|---|---|---|---|\n| ops | SIMULATED | x | the layout |\n' > "$r/docs/agents/core/thing/interviews.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "one spec checked"
out="$( cd "$r" && sh scripts/check-wireframe.sh --since "$base" )"
if printf '%s' "$out" | grep -q '1 spec(s) checked'; then
  ok "the pass message reports how many specs it checked"
else bad "the pass message does not report a count" "$out"; fi

# case 12: a structural change touching NO spec is not this gate's case — and it says so, rather than
# reporting a pass about a decision it never made.
r="$(mkrepo pass-nospec-touched)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/src"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "code only"
out="$( cd "$r" && sh scripts/check-wireframe.sh --since "$base" )"
if printf '%s' "$out" | grep -q 'no spec touched'; then
  ok "a change touching no spec defers to the spec rung explicitly"
else bad "the gate did not defer explicitly when no spec was touched" "$out"; fi

# case 13: a MARKDOWN-WRAPPED reasoned n/a → PASS. This is the regression that shipped broken: the
# opt-out pattern required whitespace directly after the colon, but a real spec line reads
# "- **Wireframe:** `n/a — reason`" — space, then backtick. The opt-out silently did not match, the
# keyword fallback then read the REASON TEXT ("no user-facing surface") as evidence the spec WAS
# user-facing, and both halves of the rule failed in the same direction. Caught by running the gate on
# its own spec, not by a fixture — hence this case.
r="$(mkrepo pass-markdown-na)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/thing" "$r/src"
# shellcheck disable=SC2016  # markdown backticks inside the fixture text
printf '# Spec\n\n- **FR-001**: a migration runner.\n- **Wireframe:** `n/a — no user-facing surface` (a CLI)\n' > "$r/docs/agents/core/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "markdown-wrapped n/a"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "a markdown-wrapped reasoned n/a is honoured"
else bad "a markdown-wrapped reasoned n/a was ignored (got '$rc')"; fi


# case 14: an ARCHIVED spec is history — a user-facing surface with no wireframe must not be re-graded
# once the spec sits under `<area>/completed/`. The same spec live is refused by case 2.
r="$(mkrepo pass-archived)"; base="$(git -C "$r" rev-parse HEAD)"
mkdir -p "$r/docs/agents/core/completed/thing" "$r/src"
printf '# Spec\n\n- **FR-001**: the records screen lists the rows.\n' > "$r/docs/agents/core/completed/thing/spec.md"
printf 'x\n' > "$r/src/x.ts"
cmit "$r" "archived spec, no wireframe"
rc="$(gate_class "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "an archived spec is not re-graded by the wireframe rung"
else bad "an archived spec was re-graded (got '$rc')"; fi

printf '\ncheck-wireframe canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
