#!/usr/bin/env sh
# check-plan-home.test.sh — canary for check-plan-home.sh.
#
# Why this exists: a pattern-matching gate that only ever reports "OK" looks identical to a gate that
# works — and this gate was CI-wired in the shipped template with no canary of its own, so the kit was
# trusting a check nobody had ever seen fail. This asserts BOTH directions — a repo with a stray plan
# doc outside the doc spine is REFUSED, a repo whose plan is in the spine PASSES — plus the argv
# variants, the allowlist, the escape hatch, and the "no plan home at all" case, so "detects
# correctly" is distinguishable from "blocks nothing" and from "blocks everything".
#
# THE TRAP THIS CANARY MUST AVOID (learned by the algorithm and spec canaries, which each shipped it
# once): a fixture helper that prints diagnostics on STDOUT while being called from inside `mkrepo`,
# whose stdout IS the fixture path, corrupts the captured path and every case fails for a reason
# unrelated to the gate. Rule: helpers mkrepo calls write to STDERR only, and mkrepo asserts its own
# stdout.
#
#   sh scripts/check-plan-home.test.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/check-plan-home.sh"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t plan-home-canary)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Make a scratch repo seeded with a canonical plan home and a base commit, and print its path. Prints
# ONE clean line on stdout; diagnostics go to stderr. Everything is pinned — identity, no hooks, no
# global config — so the canary inherits nothing from the machine it runs on.
# A $2 of "no-home" seeds a repo WITHOUT docs/agents/roadmap.md (the no-plan-home case).
mkrepo() {
  d="$TMP/$1"
  mkdir -p "$d/scripts"
  git -C "$d" init -q 2>/dev/null || { printf 'cannot init git repo\n' >&2; exit 2; }
  git -C "$d" config user.email canary@example.invalid
  git -C "$d" config user.name canary
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.hooksPath /dev/null
  git -C "$d" symbolic-ref HEAD refs/heads/main
  cp "$GATE" "$d/scripts/check-plan-home.sh"
  printf 'base\n' > "$d/README.md"
  if [ "${2:-}" != "no-home" ]; then
    mkdir -p "$d/docs/agents"
    printf '# Roadmap\n\n| Initiative | State |\n|---|---|\n' > "$d/docs/agents/roadmap.md"
  fi
  git -C "$d" add -A
  cmit "$d" base || exit 2
  case "$d" in
    ""|*"
"*) printf 'canary fixture broken: path is not one clean line: %s\n' "$d" >&2; exit 2 ;;
  esac
  printf '%s' "$d"
}

# Commit inside a fixture and ASSERT it landed. Prints NOTHING on success.
cmit() {
  d="$1"; msg="$2"
  before="$(git -C "$d" rev-list --count HEAD 2>/dev/null || echo 0)"
  ( cd "$d" && git commit -q --no-verify -m "$msg" ) >/dev/null 2>&1 || true
  after="$(git -C "$d" rev-list --count HEAD 2>/dev/null || echo 0)"
  if [ "$after" -le "$before" ]; then
    printf 'canary fixture: commit did not land in %s (%s -> %s)\n' "$d" "$before" "$after" >&2
    return 1
  fi
  return 0
}

# Run the gate against a fixture. Echoes ok / fail-stray / fail-nohome / fail-errored. A refusal is a
# finding; a missing plan home is a distinct finding; a gate error is a broken gate — conflating them
# is how an always-blocking gate passes a naive test.
gate_at() {
  d="$1"; shift
  out="$( ( cd "$d" && sh scripts/check-plan-home.sh "$@" ) 2>&1 )" && { printf 'ok'; return 0; }
  case "$out" in
    *"plan doc(s) outside the canonical home"*) printf 'fail-stray' ;;
    *"is missing"*)                             printf 'fail-nohome' ;;
    *)                                          printf 'fail-errored' ;;
  esac
}

# Does the refusal name the remedy? A gate that stops an agent without telling it the way forward just
# produces a retry loop.
gate_at_msg() { ( cd "$1" && sh scripts/check-plan-home.sh ) 2>&1 | grep -q "$2"; }

# --- case 1: a stray root PLAN.md → REFUSED --------------------------------
r="$(mkrepo fail-root-plan)"; [ -n "$r" ] || exit 2
printf '# Plan\n\ncompeting plan doc at the root.\n' > "$r/PLAN.md"
git -C "$r" add -A; cmit "$r" "docs: stray root plan" || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "fail-stray" ]; then ok "a stray root PLAN.md is refused"
else bad "expected a stray refusal, got '$rc'"; fi
if gate_at_msg "$r" "roadmap.md"; then ok "refusal names the canonical home (no retry loop)"
else bad "refusal does not name the canonical home"; fi

# --- case 2: a plan-shaped variant (*-plan.md) at the root → REFUSED --------
# The basename taxonomy, not just the literal "PLAN.md" — a gate that only knows one spelling misses
# the real-world drift this rule was written for.
r="$(mkrepo fail-root-feature-plan)"; [ -n "$r" ] || exit 2
printf '# Feature plan\n' > "$r/feature-plan.md"
git -C "$r" add -A; cmit "$r" "docs: feature plan at root" || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "fail-stray" ]; then ok "a stray root feature-plan.md is refused"
else bad "expected a stray refusal for feature-plan.md, got '$rc'"; fi

# --- case 3: a flat plan in docs/agents/ (not under an area) → REFUSED ------
# Inside the doc tree but not in the canonical home: docs/agents/plan.md competes with the roadmap.
r="$(mkrepo fail-flat-plan)"; [ -n "$r" ] || exit 2
printf '# Plan\n' > "$r/docs/agents/plan.md"
git -C "$r" add -A; cmit "$r" "docs: flat plan" || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "fail-stray" ]; then ok "a flat docs/agents/plan.md is refused"
else bad "expected a stray refusal for a flat docs/agents/plan.md, got '$rc'"; fi

# --- case 4: plan in the doc spine → PASS (positive control) ----------------
# THE case that matters most: a repo following the convention must not be blocked. docs/agents/<area>/
# <feature>/plan.md is the allowed detail home.
r="$(mkrepo pass-in-spine)"; [ -n "$r" ] || exit 2
mkdir -p "$r/docs/agents/core/thing"
printf '# Plan: thing\n' > "$r/docs/agents/core/thing/plan.md"
git -C "$r" add -A; cmit "$r" "docs: plan in the spine" || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "ok" ]; then ok "a plan in the doc spine passes (positive control)"
else bad "a compliant repo must pass — a gate that blocks its own remedy is unsatisfiable (got '$rc')"; fi

# --- case 5: the canonical roadmap itself is NOT a stray --------------------
# roadmap.md is plan-shaped by basename and sits at docs/agents/roadmap.md; the allowlist must exempt
# the canonical home or every correctly-adopted repo reads as broken.
r="$(mkrepo pass-canonical)"; [ -n "$r" ] || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "ok" ]; then ok "the canonical roadmap.md is not flagged as a stray"
else bad "the canonical home was flagged as a stray (got '$rc')"; fi

# --- case 6: a compliant repo is NOT a false green either — the allowlist does not swallow root ---
# Negative control for case 5: the exemption must be scoped. A stray beside the canonical home is
# still refused.
r="$(mkrepo fail-stray-beside-canonical)"; [ -n "$r" ] || exit 2
mkdir -p "$r/docs/agents/core/thing"
printf '# Plan\n' > "$r/docs/agents/core/thing/plan.md"
printf '# Plan\n' > "$r/ROADMAP.md"
git -C "$r" add -A; cmit "$r" "docs: stray beside canonical" || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "fail-stray" ]; then ok "a stray beside a compliant spine is still refused (negative control)"
else bad "allowlist leaked: a root ROADMAP.md was not refused (got '$rc')"; fi

# --- case 7: no canonical home at all → REFUSED -----------------------------
# A repo with no roadmap has no plan home; the gate must say so rather than pass vacuously.
r="$(mkrepo fail-no-home no-home)"; [ -n "$r" ] || exit 2
rc="$(gate_at "$r")"
if [ "$rc" = "fail-nohome" ]; then ok "a repo with no canonical plan home is refused"
else bad "expected a no-home refusal, got '$rc'"; fi

# --- case 8: PLAN_HOME_ALLOW exempts a named path (both directions) ---------
# The escape for a legitimate exception must lift a refusal AND must not exempt everything.
r="$(mkrepo allow-exception)"; [ -n "$r" ] || exit 2
mkdir -p "$r/legacy"
printf '# Old plan\n' > "$r/legacy/PLAN.md"
git -C "$r" add -A; cmit "$r" "docs: legacy plan" || exit 2
off="$(gate_at "$r")"
on="$( ( cd "$r" && PLAN_HOME_ALLOW="legacy/PLAN.md" sh scripts/check-plan-home.sh ) >/dev/null 2>&1 && printf ok || printf refused )"
if [ "$off" = "fail-stray" ] && [ "$on" = "ok" ]; then ok "PLAN_HOME_ALLOW exempts a named path (refuse → allow)"
else bad "PLAN_HOME_ALLOW did not scope (off='$off' on='$on')"; fi

# --- case 9: the escape hatch actually lifts the gate -----------------------
r="$(mkrepo pass-escape-hatch)"; [ -n "$r" ] || exit 2
printf '# Plan\n' > "$r/PLAN.md"
git -C "$r" add -A; cmit "$r" "docs: stray" || exit 2
if ( cd "$r" && PLAN_HOME_OFF=1 sh scripts/check-plan-home.sh >/dev/null 2>&1 ); then
  ok "PLAN_HOME_OFF=1 lifts the gate"
else bad "escape hatch did not lift the gate"; fi

# --- case 10: --staged refuses a NEWLY staged stray -------------------------
# The pre-commit path an agent actually uses.
r="$(mkrepo staged-new-stray)"; [ -n "$r" ] || exit 2
printf '# Plan\n' > "$r/PLAN.md"
git -C "$r" add -A
out="$( ( cd "$r" && sh scripts/check-plan-home.sh --staged ) 2>&1 )" && rc=ok || rc=refused
if [ "$rc" = "refused" ] && printf '%s' "$out" | grep -q "plan doc(s) outside the canonical home"; then
  ok "--staged refuses a newly staged stray"
else bad "--staged: expected a refusal, got '$rc' / $(printf '%s' "$out" | head -1)"; fi

# --- case 11: --staged does NOT block an edit to an already-known stray -----
# diff-filter=A is deliberate: editing (or renaming) a stray that predates the gate must not block an
# unrelated commit — otherwise adopting the gate freezes the repo. Negative control for case 10.
r="$(mkrepo staged-edit-known)"; [ -n "$r" ] || exit 2
printf '# Plan\n' > "$r/PLAN.md"
git -C "$r" add -A; cmit "$r" "docs: known stray" || exit 2
printf '# Plan\n\nedited.\n' > "$r/PLAN.md"
git -C "$r" add -A
if ( cd "$r" && sh scripts/check-plan-home.sh --staged >/dev/null 2>&1 ); then
  ok "--staged passes an edit to an already-tracked stray (diff-filter=A)"
else bad "--staged blocked an edit to an existing stray"; fi

# --- case 12: the gate must not mutate the repo it judges -------------------
r="$(mkrepo no-mutation)"; [ -n "$r" ] || exit 2
printf '# Plan\n' > "$r/PLAN.md"
git -C "$r" add -A; cmit "$r" "docs: stray" || exit 2
before="$(git -C "$r" status --porcelain)"
( cd "$r" && sh scripts/check-plan-home.sh >/dev/null 2>&1 ) || true
after="$(git -C "$r" status --porcelain)"
if [ "$before" = "$after" ]; then ok "gate does not mutate the tree it judges"
else bad "gate mutated the repo: '$before' -> '$after'"; fi

printf '\ncheck-plan-home canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
