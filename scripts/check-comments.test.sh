#!/usr/bin/env sh
# check-comments.test.sh — canary for check-comments.sh.
#
# Every case asserts BOTH directions: a gate that blocks everything and a gate that detects correctly
# are indistinguishable under a single-direction test. Cases 6, 13 and 14 are the ones that matter
# most: they pin the two ways a pattern gate in this kit has historically gone wrong — matching the
# prose that TEACHES the convention, and silently comparing nothing while printing a pass.
#
#   sh scripts/check-comments.test.sh
set -u

# The gate honors COMMENTS_OFF; an inherited one from the ambient shell would make every blocking
# case pass for the wrong reason. Unset it for the duration of this run.
unset COMMENTS_OFF 2>/dev/null || true

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-comments.sh"
[ -f "$GATE" ] || { echo "canary: $GATE not found" >&2; exit 1; }
SANDBOX="$(mktemp -d 2>/dev/null || mktemp -d -t comments-canary)"
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi
}
want_in() {
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing '$3' in: $2)"; fi
}

# A fresh repo per case so no case can contaminate another. Prints ONE line — the directory — because
# the caller captures stdout; every diagnostic must go to stderr or later git calls break.
newrepo() {
  d="$SANDBOX/$1"
  mkdir -p "$d/scripts"
  (
    cd "$d" || exit 1
    git init -q .
    git config user.email "canary@example.com"
    git config user.name "canary"
    printf 'const base = 0;\n' > base.js
    git add -A
    git commit -qm base
  )
  cp "$GATE" "$d/scripts/check-comments.sh" || exit 1
  (
    cd "$d" || exit 1
    git add -A
    git commit -qm "adopt the gate"
  ) >/dev/null 2>&1
  printf '%s' "$d"
}

# Writes a fixture file from a heredoc: content on stdin, so the payload never passes through a
# single-quoted argument (which would neither expand nor survive shellcheck).
mkfile() {
  mkdir -p "$1/$(dirname "$2")"
  cat > "$1/$2"
}

# Commits the payload. The range is always pinned explicitly as HEAD~1 in the cases below, never
# inferred from ambient HEAD.
commit_payload() {
  (
    cd "$1" || exit 1
    git add -A
    git commit -qm payload
  )
}

# --- case 1: a change adding only honest comments passes ----------------------
d="$(newrepo clean)"
mkfile "$d" clean.js <<'EOF'
// The retry budget is 3 because the upstream idempotency key expires after 30s.
export function retry() { return 3; }
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "1 honest comment exits 0" "$rc" "0"
want_in "1 reports the count it compared" "$out" "comment line(s) inspected"

# --- case 2: a decorative banner fails ---------------------------------------
d="$(newrepo banner)"
mkfile "$d" banner.js <<'EOF'
// ================ Authentication ================
export function login() {}
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "2 banner exits 1" "$rc" "1"
want_in "2 names the banner" "$out" "decorative separator or banner"
want_in "2 names the file and line" "$out" "banner.js:1"

# --- case 2b: a box-drawing banner fails too ---------------------------------
d="$(newrepo box)"
mkfile "$d" Makefile <<EOF
# $(printf '\342\224\200\342\224\200\342\224\200\342\224\200 targets')
all:
	echo ok
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "2b box-drawing banner exits 1" "$rc" "1"

# --- case 3: an emoji comment fails -----------------------------------------
d="$(newrepo emoji)"
mkfile "$d" thing.py <<EOF
# $(printf '\360\237\232\200') performance notes
x = 1
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "3 emoji exits 1" "$rc" "1"
want_in "3 names the emoji" "$out" "emoji in a comment"

# --- case 3b: typography is NOT emoji (a curly apostrophe and an em dash pass)
d="$(newrepo typography)"
mkfile "$d" thing.py <<EOF
# The operator$(printf '\342\200\231')s window is 30s $(printf '\342\200\224') the TTL, not a guess.
x = 1
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "3b typography exits 0" "$rc" "0"

# --- case 4: workflow narration fails ---------------------------------------
d="$(newrepo narration)"
mkfile "$d" narration.js <<'EOF'
// Step 1: validate the input
export function v() {}
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "4 narration exits 1" "$rc" "1"
want_in "4 names the narration" "$out" "workflow narration"

# --- case 5: an end marker fails, full-line and trailing ---------------------
d="$(newrepo endmarker)"
mkfile "$d" end.js <<'EOF'
export function d() {
  return 1;
} // end if
// End of function
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "5 end marker exits 1" "$rc" "1"
want_in "5 names the end marker" "$out" "end marker"

# --- case 6: a document DISCUSSING the patterns passes ----------------------
d="$(newrepo docs)"
mkfile "$d" README.md <<'EOF'
A banner looks like `// ================ Authentication ================`.
Narration looks like `// Step 1: validate` and an end marker like `} // end if`.
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "6 markdown quoting the patterns exits 0" "$rc" "0"

# --- case 6b: the same pattern in CODE beside the doc still fails -----------
d="$(newrepo docsplus)"
mkfile "$d" README.md <<'EOF'
See `// ===== Auth =====` for the shape we refuse.
EOF
mkfile "$d" real.js <<'EOF'
// ===== Auth =====
export function a() {}
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "6b real use beside the doc still exits 1" "$rc" "1"
want_in "6b points at the code file, not the doc" "$out" "real.js:1"

# --- case 7: an all-caps label is a NOTE, never a failure -------------------
d="$(newrepo caps)"
mkfile "$d" caps.js <<'EOF'
// VALIDATION
export function v() {}
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "7 all-caps label exits 0" "$rc" "0"
want_in "7 reports it as a note" "$out" "all-caps label"

# --- case 7b: a TODO and an acronym are not even notes ---------------------
d="$(newrepo acronym)"
mkfile "$d" acronym.js <<'EOF'
// TODO retire this path once the v1 client is gone
// HTTP timeouts are 30s upstream
export function v() {}
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "7b TODO and acronym exit 0" "$rc" "0"
if printf '%s' "$out" | grep -q "all-caps label"; then
  bad "7b a TODO is not a note"
else
  ok "7b a TODO is not a note"
fi

# --- case 8: a change with no comments says so, distinctly -----------------
d="$(newrepo none)"
mkfile "$d" none.js <<'EOF'
const n = 1;
export default n;
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "8 comment-free change exits 0" "$rc" "0"
want_in "8 says nothing was compared" "$out" "0 comment lines"

# --- case 9: an unresolvable base REFUSES rather than passing ---------------
d="$(newrepo badbase)"
mkfile "$d" x.js <<'EOF'
const x = 1;
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since deadbeef 2>&1)"; rc=$?
check "9 unresolvable base exits 2" "$rc" "2"
want_in "9 says it refused" "$out" "does not resolve"

# --- case 9b: a missing --since argument is refused -------------------------
d="$(newrepo emptybase)"
out="$(cd "$d" && sh scripts/check-comments.sh --since 2>&1)"; rc=$?
check "9b empty --since exits 2" "$rc" "2"

# --- case 10: the escape hatch is declared and works -----------------------
d="$(newrepo off)"
mkfile "$d" off.js <<'EOF'
// ===== Auth =====
export function a() {}
EOF
commit_payload "$d"
out="$(cd "$d" && COMMENTS_OFF=1 sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "10 COMMENTS_OFF=1 exits 0" "$rc" "0"
want_in "10 names the hatch" "$out" "COMMENTS_OFF=1"

# --- case 11: --staged grades the index, and counts each finding ONCE ------
d="$(newrepo staged)"
mkfile "$d" s.js <<'EOF'
// ===== Auth =====
export function a() {}
EOF
(cd "$d" && git add s.js)
out="$(cd "$d" && sh scripts/check-comments.sh --staged 2>&1)"; rc=$?
check "11 staged exits 1" "$rc" "1"
n="$(printf '%s' "$out" | grep -c "decorative separator or banner")"
check "11 one finding is counted once" "$n" "1"

# --- case 12: a URL is not a comment ---------------------------------------
d="$(newrepo url)"
mkfile "$d" url.js <<'EOF'
export const docs = "https://example.com/a/b"; // the canonical copy is at https://example.com/spec
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "12 a URL in a comment exits 0" "$rc" "0"

# --- case 13: a changed gate file quoting its own examples still passes ----
d="$(newrepo self)"
cat >> "$d/scripts/check-comments.sh" <<'EOF'
# The shapes refused above: "// ============= Authentication =============",
# "// Step 1: validate", "} // end if".
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --since HEAD~1 2>&1)"; rc=$?
check "13 the gate quoting its own examples exits 0" "$rc" "0"

# --- case 14: --tree reports pre-existing debt (the audit mode is not quiet) -
d="$(newrepo tree)"
mkfile "$d" old.py <<'EOF'
# ===== an old banner =====
x = 1
EOF
commit_payload "$d"
out="$(cd "$d" && sh scripts/check-comments.sh --tree 2>&1)"; rc=$?
check "14 --tree exits 1 on pre-existing slop" "$rc" "1"
want_in "14 says it is the audit mode" "$out" "audit mode"

# --- case 15: a run never mutates the tree it judges ----------------------
d="$(newrepo nomutate)"
mkfile "$d" m.py <<'EOF'
# ===== Auth =====
x = 1
EOF
commit_payload "$d"
before="$(cd "$d" && find . -path ./.git -prune -o -type f -print | sort | xargs md5sum 2>/dev/null | md5sum)"
(cd "$d" && sh scripts/check-comments.sh --tree >/dev/null 2>&1)
after="$(cd "$d" && find . -path ./.git -prune -o -type f -print | sort | xargs md5sum 2>/dev/null | md5sum)"
check "15 the tree is byte-identical after a run" "$after" "$before"

printf '\ncheck-comments canary: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
