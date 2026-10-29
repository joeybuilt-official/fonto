#!/usr/bin/env sh
# check-conflict-markers.test.sh — canary for check-conflict-markers.sh.
#
# Every case asserts BOTH directions, because the doctrine's rule is that a gate which cannot go red is
# not evidence. Case 6 is the one that matters most: it pins the blind spot this gate was written to
# close — `sync-agents --check` passing on a file the new gate rejects. If that case ever stops
# reproducing, the two checks have converged and the reason for this gate needs re-arguing.
#
#   sh scripts/check-conflict-markers.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-conflict-markers.sh"
SANDBOX="$(mktemp -d 2>/dev/null || mktemp -d -t conflict-canary)"
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
# Written as if/then/else rather than `A && B || C`, which is not a conditional: if `ok` ever returned
# non-zero, `bad` would run too and one case would report both outcomes.
check(){
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi
}
# Membership assertion: fails if the needle is NOT present. Kept separate from `check` because most
# cases assert on an exit code and on a line of the gate's output.
want_in(){
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing '$3' in: $2)"; fi
}

# A fresh repo per case, so a case cannot be contaminated by an earlier one.
newrepo() {
  d="$SANDBOX/$1"
  mkdir -p "$d/scripts"
  (
    cd "$d" || exit 1
    git init -q .
    git config user.email "canary@example.com"
    git config user.name "canary"
  )
  cp "$GATE" "$d/scripts/check-conflict-markers.sh"
  # A minimal stand-in for the real generator, so case 6 can show --check passing on a corrupt file.
  cat > "$d/scripts/sync-agents.sh" <<'STUB'
#!/usr/bin/env sh
# Renders only ITS OWN block, exactly like the real one: anything outside the block is invisible to it.
b="$(sed -n '/PANOPLY:RULES:BEGIN/,/PANOPLY:RULES:END/p' AGENTS.md 2>/dev/null)"
[ -n "$b" ] && echo "Mirrors + AGENTS.md in sync with the preamble and rule modules." && exit 0
echo "sync: block missing" >&2; exit 1
STUB
  chmod +x "$d/scripts/sync-agents.sh"
  echo "$d"
}

# --- case 1: a clean tracked file passes -------------------------------------
d="$(newrepo clean)"
printf 'hello\nworld\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && sh scripts/check-conflict-markers.sh 2>&1)"; rc=$?
check "1 clean tree exits 0" "$rc" "0"

# --- case 2: a leftover <<<<<<< HEAD fails ----------------------------------
d="$(newrepo ouredge)"
printf 'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && sh scripts/check-conflict-markers.sh 2>&1)"; rc=$?
check "2 '<<<<<<< HEAD' exits 1" "$rc" "1"
want_in "2 names file:line" "$out" 'AGENTS.md:2:<<<<<<< HEAD'

# --- case 3: a lone '=======' is NOT decisive (Markdown heading underline) ----
d="$(newrepo equals)"
printf 'Title\n=======\nbody\n' > "$d/README.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && sh scripts/check-conflict-markers.sh 2>&1)"; rc=$?
check "3 lone '=======' does not fail (no always-red gate)" "$rc" "0"
want_in "3 the ambiguity is surfaced, not hidden" "$out" 'note —'

# --- case 4: an unresolved ref REFUSES rather than passing -------------------
d="$(newrepo badref)"
printf 'x\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && sh scripts/check-conflict-markers.sh --since deadbeefdeadbeef 2>&1)"; rc=$?
check "4 unresolvable --since exits 2, not 0" "$rc" "2"

# --- case 5: the escape hatch is declared and works -------------------------
d="$(newrepo hatch)"
printf '<<<<<<< HEAD\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && CONFLICTS_OFF=1 sh scripts/check-conflict-markers.sh 2>&1)"; rc=$?
check "5 CONFLICTS_OFF=1 exits 0" "$rc" "0"
want_in "5 hatch says so out loud" "$out" 'disabled (CONFLICTS_OFF=1)'

# --- case 6: THE BLIND SPOT — sync --check passes on the file this gate rejects
d="$(newrepo blindspot)"
printf 'PANOPLY:RULES:BEGIN\n- a rule\nPANOPLY:RULES:END\n' > "$d/AGENTS.md"
# The corruption that actually reached main: a marker ABOVE the block, plus a doubled empty block.
printf '<<<<<<< HEAD\nprose\n=======\nother prose\n>>>>>>> other\n\nPANOPLY:RULES:BEGIN\n\nPANOPLY:RULES:END\n' >> "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
( cd "$d" && sh scripts/sync-agents.sh --check ) >/dev/null 2>&1; sync_rc=$?
( cd "$d" && sh scripts/check-conflict-markers.sh ) >/dev/null 2>&1; gate_rc=$?
check "6a sync-agents --check PASSES on the corrupt file (the blind spot)" "$sync_rc" "0"
check "6b this gate FAILS on the same file" "$gate_rc" "1"

# --- case 7: --since only judges commits in range ---------------------------
d="$(newrepo since)"
printf 'clean\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm base )
base="$(cd "$d" && git rev-parse HEAD)"
printf '<<<<<<< HEAD\n' >> "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm bad )
out="$(cd "$d" && sh scripts/check-conflict-markers.sh --since "$base" 2>&1)"; rc=$?
check "7 --since finds the marker the range introduced" "$rc" "1"

# --- case 8: the gate does not flag ITSELF (regex, not a literal) ------------
d="$(newrepo selfmatch)"
cp "$GATE" "$d/scripts/check-conflict-markers.sh"
printf 'clean prose\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && sh scripts/check-conflict-markers.sh 2>&1)"; rc=$?
check "8 the gate does not match its own source" "$rc" "0"

# --- case 9: a FAILED search refuses; it must not read as a clean tree -------
# This case exists because the first version of this canary lacked it, and mutation-testing showed the
# search-failure guard could be deleted with every case still green. The upstream design this gate
# borrows had exactly that defect: `git grep` exits 1 both for "no match" and for some failures, so a
# search that never ran read as clean.
#
# The guard is exercised by making the search itself fail: the gate is run in a directory that is NOT a
# git repository, where `git grep` is fatal. Without the guard the gate would print OK and exit 0.
d="$SANDBOX/notarepo"
mkdir -p "$d/scripts"
cp "$GATE" "$d/scripts/check-conflict-markers.sh"
out="$(cd "$d" && sh scripts/check-conflict-markers.sh 2>&1)"; rc=$?
check "9 a failed search exits 2, not 0" "$rc" "2"
want_in "9 it says the search failed" "$out" 'refusing to report a clean tree'

# --- case 10: the hatch short-circuits before anything else -----------------
d="$(newrepo hatch2)"
printf '\n<<<<<<< HEAD\n' > "$d/AGENTS.md"
( cd "$d" && git add -A && git commit -qm x )
out="$(cd "$d" && CONFLICTS_OFF=1 sh scripts/check-conflict-markers.sh --since deadbeef 2>&1)"; rc=$?
check "10 hatch short-circuits BEFORE ref validation" "$rc" "0"

echo ""
echo "check-conflict-markers canary: $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
