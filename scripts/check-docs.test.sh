#!/usr/bin/env sh
# check-docs.test.sh — canary for the docs landing gate.
#
# The gate had no test. It is wired into CI and the pre-commit hook, so a regression in it either
# blocks every commit or lets undocumented code land silently — and nothing would catch either.
#
# Asserts both directions: undocumented code REFUSES, the worklog line in the SAME commit PASSES, docs
# are exempt, and DOCS_OFF lifts it. POSIX sh, no runtime deps.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-docs.sh"
pass=0
fail=0

ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

cmit() { git -C "$1" -c user.email=t@t -c user.name=t commit -q -m "$2"; }

mk_repo() {
  r="$TMP/$1"; mkdir -p "$r/scripts"
  cp "$GATE" "$r/scripts/"
  git -C "$r" init -q
  printf 'seed\n' > "$r/seed.txt"
  git -C "$r" add -A; cmit "$r" "chore: init"
  printf '%s\n' "$r"
}

# --- case 1: code with no worklog line REFUSES --------------------------------
# NOTE: the change must stay STAGED but uncommitted — --staged reads the index, so committing first
# empties the diff and the gate correctly passes. (Getting this wrong is how a canary lies.)
r="$(mk_repo fail-nodocs)"
printf 'a\n' > "$r/src.ts"
git -C "$r" add -A
if ( cd "$r" && sh scripts/check-docs.sh --staged >/dev/null 2>&1 ); then
  bad "code with no worklog line must be refused"
else ok "code with no worklog line is refused"; fi

# --- case 2: the worklog line in the SAME commit PASSES (positive control) ----
r="$(mk_repo pass-same-commit)"
printf 'a\n' > "$r/src.ts"
printf -- '- 2026-10-03 · did a thing\n' > "$r/CHANGELOG.md"
git -C "$r" add -A; cmit "$r" "feat: code with its worklog line"
if ( cd "$r" && sh scripts/check-docs.sh --staged >/dev/null 2>&1 ); then
  ok "code + worklog line in one commit passes"
else bad "the sanctioned same-commit update was refused — the gate is unpassable"; fi

# --- case 3: a docs-only change is exempt -------------------------------------
r="$(mk_repo pass-docs-only)"
printf '# note\n' > "$r/NOTES.md"
git -C "$r" add -A; cmit "$r" "docs: note"
if ( cd "$r" && sh scripts/check-docs.sh --staged >/dev/null 2>&1 ); then
  ok "a docs-only change is exempt"
else bad "a docs-only change must not need a worklog line"; fi

# --- case 4: DOCS_OFF lifts the gate ------------------------------------------
r="$(mk_repo hatch)"
printf 'a\n' > "$r/src.ts"
git -C "$r" add -A
if ( cd "$r" && DOCS_OFF=1 sh scripts/check-docs.sh --staged >/dev/null 2>&1 ); then
  ok "DOCS_OFF=1 lifts the gate (declared exception)"
else bad "escape hatch did not lift the gate"; fi

# --- case 5: the hatch is declared in the script's own usage ------------------
if grep -q 'DOCS_OFF=1' "$GATE"; then ok "the hatch is documented in the gate's usage header"
else bad "DOCS_OFF exists but is undocumented — an undeclared hatch is not a hatch"; fi

printf '\ncheck-docs canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
