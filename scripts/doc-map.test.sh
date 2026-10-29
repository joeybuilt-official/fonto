#!/bin/sh
# Canary for doc-map.sh and the mirror/scope discipline it exposed.
#
# WHY: the token cost of what an agent loads at session start is invisible. It regressed twice —
# CLAUDE.md grew to ~184KB of inlined rule bodies (silently truncated, so it neither fit nor was
# complete), and every Cursor .mdc was marked alwaysApply so the whole corpus force-loaded anyway.
# Nothing measured it, so nothing could notice. These cases make it observable.
#
# A canary must be able to FAIL. Each case below is mutation-checked by construction: it asserts a
# number or a property that a plausible edit would break.

set -u
cd "$(dirname "$0")/.." || exit 1

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got [$2] expected [$3])"; fi; }

echo "doc-map / context-budget canary"

# --- 1. the map runs and indexes every markdown file -------------------------------------------
n_map=$(sh scripts/doc-map.sh --json 2>/dev/null | awk -F'"path":' '{print NF-1}' | awk '{s+=$1} END{print s+0}')
n_disk=$(find . -name '*.md' -not -path './.git/*' -type f 2>/dev/null | wc -l | tr -d ' ')
check "map indexes the same number of docs as on disk" "$n_map" "$n_disk"

# --- 2. the header extractor reads the DECLARED condition, not the markdown ---------------------
# Regression guard: rules write `> **Applies when:** the app is ...` and an earlier extractor stopped
# at the bold markup, emitting "** the app is ..." — markup in front of the sentence, subject intact
# only by luck. It must start on a real word.
line=$(sh scripts/doc-map.sh 2>/dev/null | grep -A1 'rules/algorithm.md' | tail -1)
case "$line" in
  *'↳ always'*) ok "extractor yields the declared condition for an 'always' rule" ;;
  *) bad "extractor mangled the condition line: $line" ;;
esac

# --- 3. a mirror is an INDEX, not the ruleset ---------------------------------------------------
# The regression: inlining every rule body made each mirror ~184KB (~47k tokens) and harnesses
# truncated it, so it claimed completeness it did not have.
for m in CLAUDE.md CONVENTIONS.md; do
  [ -f "$m" ] || { continue; }
  sz=$(wc -c < "$m" | tr -d ' ')
  if [ "$sz" -lt 40000 ]; then ok "$m is an index ($sz bytes), not an inlined corpus"
  else bad "$m is $sz bytes — rule bodies are being inlined again"; fi
  if grep -q 'This file is an INDEX' "$m"; then ok "$m says what it is"
  else bad "$m does not describe itself as an index"; fi
done

# --- 4. a mirror names every rule module -------------------------------------------------------
# An index that omits modules is worse than none: you cannot read what you cannot see.
want=$(find .agents/rules -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ -f CLAUDE.md ]; then
  got=$(grep -c '^- `' CLAUDE.md)
  check "every rule module is named in the mirror index" "$got" "$want"
fi

# --- 5. conditional rules are not force-loaded --------------------------------------------------
# The second regression route: alwaysApply:true on everything forced ~47k tokens per Cursor session.
if [ -d .cursor/rules ]; then
  forced=$(grep -l 'alwaysApply: true' .cursor/rules/*.mdc 2>/dev/null | wc -l | tr -d ' ')
  total=$(find .cursor/rules -name '*.mdc' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$forced" -lt "$total" ]; then ok "some rules are path/condition scoped ($forced of $total always-on)"
  else bad "every .mdc is alwaysApply:true ($forced/$total) — the corpus force-loads again"; fi
  # and a rule that declares a condition must actually carry it into the mirror
  if grep -q 'Applies when:' .cursor/rules/api-design.mdc 2>/dev/null; then
    ok "a conditional rule carries its condition into the frontmatter"
  else bad "api-design.mdc declares a condition but the mirror drops it"; fi
fi

# --- 5b. the truncation budget: a file a loader reads WHOLE must fit ---------------------------------
# The real measured risk: AGENTS.md is read by Hermes, which truncates at ~20,000 chars. A truncated
# read is silently wrong — the reader gets a prefix and no error. This asserts the budget can fail.
_tmpbak=$(mktemp) || exit 1
cp AGENTS.md "$_tmpbak" 2>/dev/null || true
if [ -f AGENTS.md ]; then
  head -c 25000 /dev/zero | tr '\0' 'x' >> AGENTS.md
  if sh scripts/doc-map.sh --check >/dev/null 2>&1; then
    bad "an oversized AGENTS.md was accepted — the truncation budget cannot fail"
  else
    ok "an AGENTS.md past its loader's cap is refused"
  fi
  cp "$_tmpbak" AGENTS.md
fi
rm -f "$_tmpbak"

# --- 6. --check only fails on a RULE missing its condition -------------------------------------
# The gate's own contract: rule modules must be indexable; other docs need not carry the header.
sh scripts/doc-map.sh --check >/dev/null 2>&1
check "check passes on a repo whose rules all declare a condition" "$?" "0"
DOC_MAP_OFF=1 sh scripts/doc-map.sh --check >/dev/null 2>&1
check "DOC_MAP_OFF=1 disarms the check" "$?" "0"

# --- 7. a rule with no condition IS caught -----------------------------------------------------
tmpd=$(mktemp -d) || exit 1
trap 'rm -rf "$tmpd"' EXIT INT TERM
mkdir -p "$tmpd/.agents/rules"
printf '# A rule with no declared condition\n\nBody.\n' > "$tmpd/.agents/rules/broken.md"
(unset DOC_MAP_OFF; sh scripts/doc-map.sh --dir "$tmpd" --check >/dev/null 2>&1) && _refused=1 || _refused=0
if [ "$_refused" = "1" ]; then
  bad "an unindexable rule was accepted"
else
  ok "a rule module with no 'Applies when:' is refused"
fi

printf '\ndoc-map canary: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
