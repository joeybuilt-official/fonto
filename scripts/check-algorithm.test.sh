#!/usr/bin/env sh
# check-algorithm.test.sh — canary for check-algorithm.sh.
#
# Why this exists: a pattern-matching gate that only ever reports "OK" looks identical to a gate that
# works. This asserts BOTH directions — a structural change with no step-2 artifact is REFUSED, and a
# compliant one PASSES — plus the exemptions, so "detects correctly" is distinguishable from "blocks
# nothing" and from "blocks everything".
#
# TWO BUGS THIS CANARY ITSELF SHIPPED, both worth keeping in mind when editing it:
#
#  1. A fixture helper printed its diagnostics on STDOUT while being called from inside `mkrepo`,
#     whose stdout IS the fixture path (`r="$(mkrepo case1)"`). The path captured multi-line garbage
#     and every case failed for a reason unrelated to the gate — green locally, red in CI.
#     Rule: helpers that mkrepo calls write to STDERR only, and mkrepo asserts its own stdout.
#
#  2. Cases drove the gate's default `git` mode, which diffs HEAD~1...HEAD. On some runners the
#     fixture's second commit lands late or not at all, so no parent exists, the gate (correctly)
#     refuses to give a verdict, and the case fails for an environment reason. A canary must not
#     depend on the ambient git state of the machine it runs on.
#     Rule: every case passes an EXPLICIT base to the gate (`--since <sha>`), so the comparison is
#     pinned by the test rather than inferred from HEAD. HEAD-relative behavior gets its own case.
#
#   sh scripts/check-algorithm.test.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/check-algorithm.sh"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t algorithm-canary)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Make a scratch repo seeded with a base commit, and print its path. Prints ONE clean line on stdout;
# diagnostics go to stderr (see bug 1 above). Everything is pinned — identity, no hooks, no global
# config — so the canary inherits nothing from the machine it runs on (see bug 2).
mkrepo() {
  d="$TMP/$1"
  mkdir -p "$d/scripts"
  git -C "$d" init -q 2>/dev/null || { printf 'cannot init git repo\n' >&2; exit 2; }
  git -C "$d" config user.email canary@example.invalid
  git -C "$d" config user.name canary
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.hooksPath /dev/null
  git -C "$d" symbolic-ref HEAD refs/heads/main
  cp "$GATE" "$d/scripts/check-algorithm.sh"
  printf 'base\n' > "$d/README.md"
  git -C "$d" add -A
  cmit "$d" base || exit 2
  case "$d" in
    ""|*"
"*) printf 'canary fixture broken: path is not one clean line: %s\n' "$d" >&2; exit 2 ;;
  esac
  printf '%s' "$d"
}

# Commit inside a fixture and ASSERT it landed. Prints NOTHING on success (see bug 1).
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

# The root-commit SHA of a fixture — the pinned diff base every case uses.
root_sha() { git -C "$1" rev-list --max-parents=0 HEAD 2>/dev/null | head -1; }

# Run the gate against a fixture with an EXPLICIT base. Echoes ok / fail-refused / fail-unresolvable
# / fail-errored. A refusal is a finding; an unresolvable base is a broken check; a gate error is a
# broken gate — conflating them is how an always-blocking gate passes a naive test.
gate_at() {
  d="$1"; base="$2"
  out="$( ( cd "$d" && sh scripts/check-algorithm.sh --since "$base" ) 2>&1 )" && { printf 'ok'; return 0; }
  case "$out" in
    *"no Algorithm pass"*) printf 'fail-refused' ;;
    *"does not resolve"*|*"no parent commit"*) printf 'fail-unresolvable' ;;
    *) printf 'fail-errored' ;;
  esac
}

# Does the refusal name the remedy? A gate that stops an agent without telling it the way forward
# just produces a retry loop.
gate_at_msg() {
  ( cd "$1" && sh scripts/check-algorithm.sh --since "$2" ) 2>&1 | grep -q "Deletion candidates"
}

# --- case 1: structural change, no deletion section → REFUSED ---------------
r="$(mkrepo fail-no-section)"; base="$(root_sha "$r")"
mkdir -p "$r/src" "$r/docs/agents/core/thing"
printf 'x\n' > "$r/src/thing.ts"
printf '# Plan\n\n## Goal\n\nNo algorithm pass here.\n' > "$r/docs/agents/core/thing/plan.md"
git -C "$r" add -A; cmit "$r" "feat: thing" || exit 2
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "fail-refused" ]; then ok "structural change with no deletion section is refused"
else bad "expected a refusal, got '$rc'"; fi
if gate_at_msg "$r" "$base"; then ok "refusal names the remedy (no retry loop)"
else bad "refusal does not name the remedy"; fi

# --- case 2: same change, deletion section added → PASS (positive control) --
printf '# Plan\n\n## The Algorithm pass\n\n- Delete: none, argued below.\n\n### Deletion candidates\n\n| Candidate | Removed? | Why |\n|---|---|---|\n| none | no | every part has a live caller |\n' > "$r/docs/agents/core/thing/plan.md"
git -C "$r" add -A; cmit "$r" "docs: algorithm pass" || exit 2
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "compliant plan passes (positive control)"
else bad "compliant plan must pass — a gate that blocks its own remedy is unsatisfiable (got '$rc')"; fi

# --- case 3: docs-only change → PASS (exemption) ----------------------------
r="$(mkrepo pass-docs-only)"; base="$(root_sha "$r")"
printf '# Notes\n\nA copy change.\n' > "$r/NOTES.md"
git -C "$r" add -A; cmit "$r" "docs: notes" || exit 2
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "ok" ]; then ok "docs-only change passes (not structural)"
else bad "docs-only change must not require a deletion list (got '$rc')"; fi

# --- case 4: escape hatch actually lifts the gate ---------------------------
r="$(mkrepo pass-escape-hatch)"; base="$(root_sha "$r")"
mkdir -p "$r/src"; printf 'y\n' > "$r/src/other.ts"
git -C "$r" add -A; cmit "$r" "feat: other" || exit 2
if ( cd "$r" && ALGORITHM_OFF=1 sh scripts/check-algorithm.sh --since "$base" >/dev/null 2>&1 ); then
  ok "ALGORITHM_OFF=1 lifts the gate"
else bad "escape hatch did not lift the gate"; fi

# --- case 5: no plan home at all, structural change → REFUSED ---------------
r="$(mkrepo fail-no-plan)"; base="$(root_sha "$r")"
mkdir -p "$r/apps/web/src"; printf 'z\n' > "$r/apps/web/src/page.tsx"
git -C "$r" add -A; cmit "$r" "feat: page" || exit 2
rc="$(gate_at "$r" "$base")"
if [ "$rc" = "fail-refused" ]; then ok "structural change with no plan doc is refused"
else bad "expected a refusal, got '$rc'"; fi

# --- case 6: THE GATE MUST NOT BLOCK ITS OWN REMEDY -------------------------
r="$(mkrepo pass-remedy-roundtrip)"; base="$(root_sha "$r")"
mkdir -p "$r/lib" "$r/docs/agents/core/sub"
printf 'a\n' > "$r/lib/a.ts"
git -C "$r" add -A && { cmit "$r" "feat: a" || exit 2; }
first="$(gate_at "$r" "$base")"
printf '# Plan\n\n### Deletion candidates\n\n| Candidate | Removed? | Why |\n|---|---|---|\n| nothing | no | single new file |\n' > "$r/docs/agents/core/sub/plan.md"
git -C "$r" add -A && { cmit "$r" "docs: pass" || exit 2; }
second="$(gate_at "$r" "$base")"
if [ "$first" = "fail-refused" ] && [ "$second" = "ok" ]; then ok "refuse → apply the remedy → allow (round trip)"
else bad "remedy round trip broken (first='$first' second='$second')"; fi

# --- case 7: --staged reads the index (the pre-commit path) -----------------
r="$(mkrepo staged-mode)"
mkdir -p "$r/src"; printf 'b\n' > "$r/src/b.ts"
git -C "$r" add -A
out="$( ( cd "$r" && sh scripts/check-algorithm.sh --staged ) 2>&1 )" && rc=ok || rc=refused
if [ "$rc" = "refused" ] && printf '%s' "$out" | grep -q "no Algorithm pass"; then
  ok "--staged refuses an unplanned staged change"
else bad "--staged: expected a refusal, got '$rc' / $(printf '%s' "$out" | head -1)"; fi

# --- case 8: the gate must not mutate the repo it judges --------------------
r="$(mkrepo no-mutation)"; base="$(root_sha "$r")"
mkdir -p "$r/src" "$r/docs/agents/core/x"
printf 'c\n' > "$r/src/c.ts"
printf '# Plan\n\n### Deletion candidates\n\n| Candidate | Removed? | Why |\n|---|---|---|\n| none | no | new file |\n' > "$r/docs/agents/core/x/plan.md"
git -C "$r" add -A && { cmit "$r" "feat: c" || exit 2; }
before="$(git -C "$r" status --porcelain)"
( cd "$r" && sh scripts/check-algorithm.sh --since "$base" >/dev/null 2>&1 ) || true
after="$(git -C "$r" status --porcelain)"
if [ "$before" = "$after" ]; then ok "gate does not mutate the repo it judges"
else bad "gate changed repo state: '$before' -> '$after'"; fi

# --- case 9: a broken base is never a silent pass ---------------------------
# The one outcome that must never happen is a clean OK about a comparison that could not run.
r="$(mkrepo broken-base)"; base="$(root_sha "$r")"
mkdir -p "$r/src"; printf 'd\n' > "$r/src/d.ts"
git -C "$r" add -A; cmit "$r" "feat: d" || exit 2
out="$( ( cd "$r" && sh scripts/check-algorithm.sh --since deadbeefdeadbeef ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "does not resolve"; then
  ok "unresolvable base is a hard error, never a false green"
else bad "unresolvable base: rc=$rc out=$(printf '%s' "$out" | head -1)"; fi
if ( cd "$r" && sh scripts/check-algorithm.sh --since "" >/dev/null 2>&1 ); then
  bad "empty base exited 0 — a broken check must not pass"
else ok "empty base is refused, not treated as a clean run"; fi
# And the gate must still be USABLE at a real base afterwards (never block the remedy).
if [ "$(gate_at "$r" "$base")" = "fail-refused" ]; then ok "a real base still yields a verdict"
else bad "a real base did not yield a verdict"; fi

# --- case 10: HEAD-relative default mode is honest about its own limits -----
# The default mode IS used by humans and hooks, so it gets a case — but judged on the gate's own
# CONTRACT (a verdict, or a stated refusal to give one), never on the ambient commit count.
r="$(mkrepo head-mode)"
mkdir -p "$r/src"; printf 'e\n' > "$r/src/e.ts"
git -C "$r" add -A; cmit "$r" "feat: e" || exit 2
out="$( ( cd "$r" && sh scripts/check-algorithm.sh ) 2>&1 )" && rc=0 || rc=$?
case "$out" in
  *"no Algorithm pass"*)                     ok "default mode returns a finding when a parent exists" ;;
  *"no parent commit"*|*"does not resolve"*) ok "default mode refuses to answer with no parent (honest)" ;;
  *) bad "default mode gave no verdict and no refusal: $(printf '%s' "$out" | head -1)" ;;
esac

printf '\ncheck-algorithm.test: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
