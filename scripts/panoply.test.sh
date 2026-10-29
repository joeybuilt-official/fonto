#!/usr/bin/env bash
# panoply.test.sh — canary for scripts/panoply.sh.
#
# Why this exists: the kit's own rules require that any gate which pattern-matches must ship a
# fixture that carries every defect it claims to catch, plus a compliant one, and assert
# fail-then-pass. A single manual pass on a real repo cannot distinguish "compliant" from
# "detects nothing" — a check that always exits 0 looks identical to a perfect one.
#
# Asserts every state the doctor can report, by building a throwaway repo per case:
#   current(0) absent(10) partial(11) stale(12) placeholders(13) drifted(14) off(0) not-a-repo(0)
#
#   sh scripts/panoply.test.sh        (run from the kit root; used by CI)
set -u
# pipefail is a bash extension. CI invokes this gate as `sh scripts/panoply.test.sh`, where `sh` is
# dash and `set -o pipefail` is an illegal option that aborts the run before any check executes —
# a gate that cannot start reads as a broken repo rather than a broken check. Enable it only where
# the shell supports it (an `if`, not `A && B || C`, which older shellcheck flags as SC2015).
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

KIT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$KIT/scripts/panoply.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# This canary tests the KIT, and it builds its fixtures by copying the kit's own AGENTS.md, rule
# modules and sync-agents.sh. So it is only meaningful when $KIT really is the template. Deriving
# $KIT from $0 means running `sh scripts/panoply.test.sh` from ANY adopter silently makes that
# adopter the "kit" — its modules are already adapted (token-free), so `apply` seeds a repo with no
# placeholders, case 10's "post-apply is unadapted (13)" can never hold, the repo reports drift (14)
# instead, and the canary prints a FAIL that has nothing to do with the doctor. That is a false red
# in the one gate an adopter is told to run, which is worse than no gate: it trains people to ignore
# a failure. Detect the situation and SKIP loudly instead — a soft gate may skip, but never silently.
# PANOPLY_KIT_ROOT may point at a real template checkout to run it from elsewhere.
_is_template() {  # _is_template <dir> — same heuristic the doctor uses for self-detection
  [ -f "$1/scripts/init-template-repo.sh" ] && [ -f "$1/.agents/commands/adapt-agents-setup.md" ]
}
if [ -n "${PANOPLY_KIT_ROOT:-}" ] && _is_template "$PANOPLY_KIT_ROOT"; then
  KIT="$PANOPLY_KIT_ROOT"; DOC="$KIT/scripts/panoply.sh"
elif ! _is_template "$KIT"; then
  printf 'PANOPLY.TEST: SKIPPED — %s is not a kit template checkout.\n' "$KIT"
  printf '  This canary asserts the KIT doctor against fixtures built from the kit itself, so it\n'
  printf '  must run from the kit root (or with PANOPLY_KIT_ROOT=<kit checkout>).\n'
  printf '  In an ADOPTED repo, verify with:  sh scripts/panoply.sh check  &&  sh scripts/sync-agents.sh --check\n'
  exit 0
fi

pass=0; fail=0
_ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
_bad()  { fail=$((fail+1)); printf '  FAIL %s — %s\n' "$1" "$2"; }

# assert_exit <name> <expected-code> <dir>
assert_exit() {
  _n="$1"; _want="$2"; _d="$3"
  ( cd "$_d" && sh "$DOC" check ) >/dev/null 2>&1
  _got=$?
  if [ "$_got" = "$_want" ]; then _ok "$_n (exit $_got)"; else _bad "$_n" "want exit $_want, got $_got"; fi
}

_new_repo() {  # _new_repo <name> -> prints path
  _p="$WORK/$1"; mkdir -p "$_p"; ( cd "$_p" && git init -q . && printf 'x\n' > README.md \
    && git add -A && git -c user.email=t@t -c user.name=t commit -qm init ) >/dev/null 2>&1
  printf '%s' "$_p"
}

# A compliant adopter: the triad, no tokens, stamped, mirrors generated and in sync.
_make_adopted() {
  _p="$1"
  cp "$KIT/AGENTS.md" "$_p/AGENTS.md"
  sed -i 's/{{PROJECT_NAME}}/fixture/g' "$_p/AGENTS.md"
  mkdir -p "$_p/docs/agents" "$_p/.agents/rules" "$_p/scripts"
  cp "$KIT/docs/agents/roadmap.md" "$_p/docs/agents/roadmap.md" 2>/dev/null || printf '# roadmap\n' > "$_p/docs/agents/roadmap.md"
  # copy modules and strip every {{TOKEN}} so the fixture is genuinely adapted
  for _m in "$KIT"/.agents/rules/*.md; do
    b="$(basename "$_m")"; sed 's/{{[A-Z_][A-Z0-9_]*}}/fixture/g' "$_m" > "$_p/.agents/rules/$b"
  done
  cp "$KIT/scripts/sync-agents.sh" "$_p/scripts/sync-agents.sh"
  ( cd "$_p" && PANOPLY_SELF=0 sh scripts/sync-agents.sh ) >/dev/null 2>&1
  ( cd "$_p" && sh "$DOC" stamp ) >/dev/null 2>&1
}

echo "panoply.test.sh — kit $("$DOC" version)"

# --- case 1: absent ----------------------------------------------------------------------------
R="$(_new_repo absent)";            assert_exit "absent repo"            10 "$R"
# --- case 2: partial (AGENTS.md only) ----------------------------------------------------------
R="$(_new_repo partial)"; cp "$KIT/AGENTS.md" "$R/AGENTS.md"; sed -i 's/{{PROJECT_NAME}}/p/g' "$R/AGENTS.md"
                                    assert_exit "half-applied repo"      11 "$R"
# --- case 3: unadapted (triad present, tokens left) --------------------------------------------
R="$(_new_repo unadapted)"; _make_adopted "$R"
sed -i 's/fixture/{{PROJECT_NAME}}/' "$R/AGENTS.md"          # re-introduce one token
                                    assert_exit "unfilled placeholders"  13 "$R"
# --- case 4: stale (adapted, no stamp) ---------------------------------------------------------
R="$(_new_repo stale)"; _make_adopted "$R"; rm -f "$R/.panoply-version"
                                    assert_exit "stale (no stamp)"       12 "$R"
# --- case 5: stale (stamp behind) --------------------------------------------------------------
R="$(_new_repo stale2)"; _make_adopted "$R"
sed -i 's/^kit_version: .*/kit_version: v0.0.1/' "$R/.panoply-version"
                                    assert_exit "stale (old version)"    12 "$R"
# --- case 6: drifted mirrors -------------------------------------------------------------------
R="$(_new_repo drifted)"; _make_adopted "$R"
# Generate at least one tool-native mirror so --check has something to compare, then corrupt it.
( cd "$R" && PANOPLY_SELF=0 sh scripts/sync-agents.sh ) >/dev/null 2>&1
printf '\nhand edit that bypasses the generator\n' >> "$R/CONVENTIONS.md"
                                    assert_exit "drifted mirrors"        14 "$R"
# --- case 7: current ---------------------------------------------------------------------------
R="$(_new_repo current)"; _make_adopted "$R"
                                    assert_exit "compliant adopter"       0 "$R"
# --- case 8: escape hatch ----------------------------------------------------------------------
R="$(_new_repo off)"; ( cd "$R" && PANOPLY_OFF=1 sh "$DOC" check ) >/dev/null 2>&1
_off=$?
# Prefer an if over `A && B || C`: SC2015 (shellcheck <= 0.11) fires on the chain, and CI runs an
# older shellcheck than this box does, so the chain passes locally and fails the PR.
if [ "$_off" = 0 ]; then _ok "PANOPLY_OFF escape hatch (exit 0)"; else _bad "PANOPLY_OFF" "got $_off"; fi
# --- case 9: not a git tree must never block ---------------------------------------------------
R="$WORK/nogit"; mkdir -p "$R";     assert_exit "non-git dir is not blocked" 0 "$R"

# --- case 10: apply must reach a state the agent can FINISH -------------------------------------
# Why this case exists: apply originally seeded the spine and the rule modules but never AGENTS.md,
# so every adoption stalled at exit 11 ("half-applied — missing AGENTS.md") with no file to fill.
# apply could not reach a state an agent could complete from, which made the runbook a dead end.
# The check here is the CONTRACT, not the mechanism: after apply, the repo must be reportable as
# unadapted (13) — i.e. hub present with tokens to fill — and must never be back at 11.
R="$(_new_repo applies)"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
_apply_rc=$?
if [ "$_apply_rc" = 0 ]; then _ok "apply exits 0"; else _bad "apply exits 0" "got $_apply_rc"; fi
if [ -f "$R/AGENTS.md" ]; then _ok "apply seeds an AGENTS.md hub"; else _bad "apply seeds an AGENTS.md hub" "absent"; fi
assert_exit "post-apply is unadapted, not half-applied" 13 "$R"
# A repo with its OWN hub must be left untouched by apply (the judgement half merges it).
R="$(_new_repo ownhub)"
printf '# my own hub\nno tokens here\n' > "$R/AGENTS.md"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
if grep -q 'my own hub' "$R/AGENTS.md" && ! grep -q '{{\|PANOPLY:RULES' "$R/AGENTS.md"; then
  _ok "apply never clobbers an existing AGENTS.md"
else
  _bad "apply never clobbers an existing AGENTS.md" "hub was replaced by the kit template"
fi

# --- case 11: the COPY-OF-THE-DOCTOR must resolve the KIT's version, not the adopter's -----------
# Why this case exists: `apply` copies panoply.sh into the adopted repo so it can self-check. Once
# copied, `$0` resolves to the ADOPTER, so version resolution read the adopter's own git tags. A
# repo with any unrelated tag (e.g. its own v1.0.0 product release) then never matched the kit's
# stamp and reported "stale" forever — an always-red gate on a perfectly compliant repo.
R="$(_new_repo copydoctor)"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
( cd "$R" && git tag v9.9.9-product-release ) >/dev/null 2>&1   # an unrelated adopter tag
_v_local="$( cd "$R" && sh scripts/panoply.sh version 2>/dev/null )"
_v_kit="$("$DOC" version)"
if [ "$_v_local" = "$_v_kit" ]; then
  _ok "copied doctor reports the kit version ($_v_local), not the adopter's tag"
else
  _bad "copied doctor reports the kit version" "local gave '$_v_local', kit is '$_v_kit'"
fi

# --- case 11b: the copy must agree with the SOURCE when the kit sits BETWEEN releases ------------
# Why this case exists: version resolution asked two different questions depending on which tree
# answered it. From the kit SOURCE it asked "what release is this?" (`git describe --tags --abbrev=0`
# on a checkout with untagged commits since the last tag yields `v1.4.0-14-gc0dee04`, and the
# `[ -n "$v" ]` guard then reads that as a version — not `unreleased`). From a CANONICAL CLONE it
# asked "what is the nearest ancestor tag?", which is a different question with a different answer.
# So `apply` stamped one value and the copied doctor reported another, and the mismatch only appeared
# for whoever happened to have a canonical clone on the machine — a local-only false red in the one
# gate adopters are told to run.
#
# The bug hides on a machine with no canonical clone (`_canonical_kit_root` fails, the stamp is
# believed, both agree) and on a tagged kit checkout. It shows up exactly when the kit has untagged
# commits AND a clone exists. Force BOTH conditions here, or this case passes for the wrong reason.
R="$(_new_repo copydoctor-between)"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
_canon="$WORK/canon-between"
if git -C "$KIT" rev-parse --verify HEAD >/dev/null 2>&1; then
  git clone -q "$KIT" "$_canon" >/dev/null 2>&1 || _canon=""
fi
# NOTE: gating on _at_tag made this case SKIP under mutation — reintroducing the bug (`--abbrev=0`)
# makes the source report a tag, so the guard judged "source is tagged" and disabled the very case
# meant to catch it. A canary that skips when the defect is present proves nothing. So the gate is
# on the RAW tree state (does this checkout carry a reachable tag at HEAD?), never on the value the
# code under test produces.
if [ -n "$_canon" ]; then
  _faketop="$WORK/fakehome"
  mkdir -p "$_faketop/.cache"
  _origin="$(git -C "$KIT" remote get-url origin 2>/dev/null || true)"
  if [ -n "$_origin" ] && git clone -q "$_origin" "$_faketop/.cache/panoply" >/dev/null 2>&1; then
    _v_local2="$( cd "$R" && env -u PANOPLY_KIT_ROOT HOME="$_faketop" sh scripts/panoply.sh version 2>/dev/null )"
    _v_kit2="$( sh "$DOC" version 2>/dev/null )"
    if [ "$_v_local2" = "$_v_kit2" ]; then
      _ok "copied doctor agrees with the source ($_v_local2)"
    else
      _bad "copied doctor agrees with the source" \
           "copy said '$_v_local2', source said '$_v_kit2' — version resolution asks two questions"
    fi
  else
    _ok "copied-doctor canonical-clone case skipped (no canonical clone could be staged)"
  fi
else
  _ok "copied-doctor canonical-clone case skipped (source worktree has no remote)"
fi

# --- case 12: apply must NEVER silently clobber a locally-edited script -------------------------
# Why: a pilot repo's check-docs.sh carries a conflict-marker sweep the kit template lacks. apply cp'd the
# template over it with no NOTE at all — an unreported capability regression, and the same hazard for
# sync-agents.sh / check-plan-home.sh (any repo-local edit). Rule modules already reported divergence;
# scripts did not. The contract: install when absent, report when it differs, replace only under an
# explicit --force-scripts. A diverged SCRIPT is DRIFT (kit machinery the adopter should refresh), so
# the report word is DRIFTED — not the old KEPT, which hid it as benign.
R="$(_new_repo scriptclobber)"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
printf '\n# LOCAL CUSTOMIZATION MARKER\n' >> "$R/scripts/check-docs.sh"
_out="$( cd "$R" && sh "$DOC" apply 2>&1 )"
if grep -q 'LOCAL CUSTOMIZATION MARKER' "$R/scripts/check-docs.sh"; then
  _ok "apply preserves a locally-edited script"
else
  _bad "apply preserves a locally-edited script" "the local edit was clobbered silently"
fi
if printf '%s' "$_out" | grep -q 'DRIFTED scripts/check-docs.sh'; then
  _ok "apply reports the drifted script (not silent)"
else
  _bad "apply reports the drifted script" "no DRIFTED line in apply output"
fi
# --- case 12b (ADVERSARIAL, M2): apply must NOT stamp current a repo it left drifted -------------
# The owner-verified defect: apply kept every local script, changed nothing, and still rewrote the
# stamp to the kit's version — certifying code that was not installed. The stamp is now written with a
# +drifted marker when any managed file was left different, so the very file readers trust carries the
# drift. Assert the stamp is NOT the bare kit version (the lie), and that apply itself returns non-zero.
_stamp_ver="$(sed -n 's/^kit_version:[[:space:]]*//p' "$R/.panoply-version" | head -1)"
_kit_ver="$("$DOC" version)"
if [ "$_stamp_ver" = "$_kit_ver" ]; then
  _bad "drifted apply does not stamp current" "stamp says '$_stamp_ver' == kit '$_kit_ver' — certifies code not installed"
else
  _ok "drifted apply does not stamp current (stamp '$_stamp_ver', kit '$_kit_ver')"
fi
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
_arc=$?
if [ "$_arc" != 0 ]; then
  _ok "drifted apply exits non-zero (drift is loud, got $_arc)"
else
  _bad "drifted apply exits non-zero" "a drifted apply returned 0 — the reader can mistake it for success"
fi

# --- case 13 (ADVERSARIAL, M1): a repo running a STALE DOCTOR is not reported OK -----------------
# The owner-verified false green: a pilot repo's own copy reports `OK — kit v1.4.0 applied and
# current` (exit 0) while the current doctor reports HALF-APPLIED (exit 11) on the same repo. The stale
# copy cannot see itself (it lacks the code), so the fix is: ANY doctor that carries the generation
# marker reports self-stale when the repo's own committed doctor copy predates it. Build exactly that —
# a compliant new-layout fixture carrying an OLD (marker-less) scripts/panoply.sh, checked by the
# CURRENT doctor.
R="$(_new_repo stalecopydoctor)"
_make_adopted "$R"
# The repo's committed doctor, as an old kit generation shipped it: a copy with NO
# `_PANOPLY_GENERATION` anywhere. Build it by STRIPPING the marker from the current doctor rather than
# reading it out of `origin/main` — main moves, so a fixture sourced from it stops being "old" the
# moment the marker lands there (which is exactly what happened: this case passed on its branch and
# went red on merge). A fixture built from a moving ref tests the ref, not the behaviour. Any line that
# READS the marker must be stripped too, or the copy would reintroduce one.
{ printf '#!/usr/bin/env sh\n'; grep -v '^_PANOPLY_GENERATION=' "$DOC" | grep -vF "$_PANOPLY_GENERATION"; } > "$R/scripts/panoply.sh"
chmod +x "$R/scripts/panoply.sh"
if grep -q '_PANOPLY_GENERATION' "$R/scripts/panoply.sh"; then
  _bad "case 13 fixture is a marker-less old doctor" "the marker survived the strip — the fixture is not an old copy"
else
  # The CURRENT doctor, run in that repo, must call it self-stale — never OK.
  ( cd "$R" && sh "$DOC" check ) >/dev/null 2>&1
  _st=$?
  if [ "$_st" = 15 ]; then _ok "stale repo doctor is reported self-stale (exit 15)"; else _bad "stale repo doctor is reported self-stale" "got exit $_st, want 15"; fi
  # Capture the text without a `A && B || C` chain (SC2015: C may run when A is true). The subshell
  # always runs; its non-zero exit is expected and discarded deliberately.
  ( cd "$R" && sh "$DOC" check ) >"$WORK/case13.out" 2>&1
  _okso="$(cat "$WORK/case13.out")"
  if printf '%s' "$_okso" | grep -q 'OK —'; then
    _bad "stale repo doctor is NOT reported OK" "a modern doctor claimed OK over an old copy — the false green survived"
  else
    _ok "stale repo doctor is NOT reported OK"
  fi
fi

# --- case 13a (M1, running a marker-less copy directly): it must refuse, not claim OK -------------
# The direct false-green path: an adopter runs its OWN marker-less copy. It cannot report self-stale
# (it predates the code), but a marker-less doctor must NOT be able to certify a repo it validates
# against a superseded layout. The new doctor's own guard is the `_mygen`-empty branch, so exercising
# it here proves the branch is reachable: strip the marker from a copy and run it.
R="$(_new_repo markerlesscopy)"
_make_adopted "$R"
{ printf '#!/usr/bin/env sh\n'; grep -v '^_PANOPLY_GENERATION=' "$DOC" | grep -vF "\$_PANOPLY_GENERATION"; } > "$R/scripts/panoply.sh"
chmod +x "$R/scripts/panoply.sh"
( cd "$R" && sh scripts/panoply.sh check ) >/dev/null 2>&1
_st=$?
if [ "$_st" = 15 ]; then
  _ok "a marker-less running copy refuses to certify (exit 15)"
else
  _bad "a marker-less running copy refuses to certify" "got exit $_st, want 15 — the copy validated against its own obsolete layout"
fi

# --- case 13b (M1 control): a copy of the CURRENT doctor on a compliant repo still passes ---------
# The detection must not be an always-red gate: a copy of the current doctor, on a repo it built
# correctly, must still exit 0. This is the positive control that makes case 13 evidence.
R="$(_new_repo currentcopydoctor)"
_make_adopted "$R"
cp "$DOC" "$R/scripts/panoply.sh"
( cd "$R" && sh scripts/panoply.sh check --quiet ) >/dev/null 2>&1
_st=$?
if [ "$_st" = 0 ]; then _ok "current copy on a compliant repo still passes (exit 0)"; else _bad "current copy positive control" "got exit $_st, want 0"; fi

# --- case 13c (M1, reachable-source): a copy whose generation DISAGREES with a reachable source ----
# The second tell: when a source IS reachable and its generation differs from the copy's, that is proof.
# Simulate by pointing PANOPLY_KIT_ROOT at a source carrying a DIFFERENT generation marker.
R="$(_new_repo selsrc)"
_make_adopted "$R"
cp "$DOC" "$R/scripts/panoply.sh"
_fakesrc="$WORK/fake-kit-src"
mkdir -p "$_fakesrc/scripts"
sed 's/^_PANOPLY_GENERATION=".*"/_PANOPLY_GENERATION="layout-agents-FUTURE"/' "$DOC" > "$_fakesrc/scripts/panoply.sh"
( cd "$R" && PANOPLY_KIT_ROOT="$_fakesrc" sh scripts/panoply.sh check ) >/dev/null 2>&1
_st=$?
if [ "$_st" = 15 ]; then _ok "copy disagrees with reachable source -> self-stale (exit 15)"; else _bad "source-generation mismatch" "got exit $_st, want 15"; fi

# --- case 14 (ADVERSARIAL, M3): --force-scripts must leave a RECOVERABLE backup ------------------
# The owner-verified defect: --force-scripts overwrote a locally-edited script with no .bak and no
# stated location; recovery was only via git. Assert the pre-overwrite bytes survive in a backup and
# that the command names where they went.
R="$(_new_repo forcebackup)"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
printf '\n# IRREPLACEABLE LOCAL WORK\n' >> "$R/scripts/check-docs.sh"
_out="$( cd "$R" && sh "$DOC" apply --force-scripts 2>&1 )"
_bak="$(find "$R/scripts" -maxdepth 1 -name 'check-docs.sh.panoply-bak*' 2>/dev/null | head -1)"
if [ -n "$_bak" ] && grep -q 'IRREPLACEABLE LOCAL WORK' "$_bak"; then
  _ok "--force-scripts leaves a recoverable backup with the pre-overwrite bytes"
else
  _bad "--force-scripts leaves a recoverable backup" "no backup carrying the local work"
fi
if printf '%s' "$_out" | grep -q 'previous copy saved to scripts/check-docs.sh.panoply-bak'; then
  _ok "--force-scripts names the backup path"
else
  _bad "--force-scripts names the backup path" "the backup location was not printed"
fi
# and no spurious backup when there is nothing to overwrite (a clean script is not backed up)
_before="$(find "$R/scripts" -maxdepth 1 -name 'sync-agents.sh.panoply-bak*' 2>/dev/null | wc -l | tr -d ' ')"
( cd "$R" && sh "$DOC" apply --force-scripts ) >/dev/null 2>&1
_after="$(find "$R/scripts" -maxdepth 1 -name 'sync-agents.sh.panoply-bak*' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$_before" = "$_after" ]; then
  _ok "--force-scripts backs up nothing it did not overwrite"
else
  _bad "--force-scripts backs up nothing it did not overwrite" "a matching script grew a backup"
fi

# --- case 15 (M4): migrate translates an OLD-layout adopter and reports it FIRST ------------------
# Build an adopter-shaped OLD-layout repo (docs/claude + .claude/rules), then migrate it. Assert: the
# translation is reported, the new tree is seeded from the repo's own adapted content, the old tree is
# NOT deleted, and afterwards the repo is on the current layout.
R="$(_new_repo oldlayout)"
_make_adopted "$R"
# Convert to old layout: move the new tree into the old names.
mkdir -p "$R/docs/claude" "$R/.claude/rules"
mv "$R"/docs/agents/* "$R/docs/claude/" 2>/dev/null || true
mv "$R"/.agents/rules/* "$R/.claude/rules/" 2>/dev/null || true
rm -rf "$R/docs/agents" "$R/.agents/rules"
# Give the fixture a REAL old doctor — a marker-less copy built by stripping the marker from the
# current one, as an adopter of the old generation would actually carry. NOT read from `origin/main`:
# main now carries the marker, so a fixture sourced there is no longer "old" (this exact idiom broke
# case 13 on merge). Stripping is state-independent and keeps the self-stale tell (c) exercised, so
# migrate's doctor-refresh has work to do.
{ printf '#!/usr/bin/env sh\n'; grep -v '^_PANOPLY_GENERATION=' "$DOC" | grep -vF "$_PANOPLY_GENERATION"; } > "$R/scripts/panoply.sh"
chmod +x "$R/scripts/panoply.sh"
# sanity: the CURRENT doctor must call it self-stale (the repo runs an old copy) — exit 15, not 11.
assert_exit "old-layout repo with an old doctor is self-stale to the current doctor" 15 "$R"
_mout="$( cd "$R" && sh "$DOC" migrate 2>&1 )"
if printf '%s' "$_mout" | grep -q 'docs/claude/     -> docs/agents/'; then
  _ok "migrate reports the layout translation before changing anything"
else
  _bad "migrate reports the translation" "no translation report in migrate output"
fi
if [ -d "$R/docs/claude" ]; then
  _ok "migrate leaves the old tree in place for review"
else
  _bad "migrate leaves the old tree in place" "the old tree was deleted without review"
fi
if [ -f "$R/docs/agents/roadmap.md" ] && [ -d "$R/.agents/rules" ]; then
  _ok "migrate seeds the current layout"
else
  _bad "migrate seeds the current layout" "docs/agents/roadmap.md or .agents/rules still absent"
fi
# migrate must refresh the doctor itself (backing up the old copy), so the next check runs the current
# one. Without this the repo keeps running the stale copy it was told to replace.
if [ -f "$R/scripts/panoply.sh.panoply-bak" ] && grep -q '_PANOPLY_GENERATION' "$R/scripts/panoply.sh"; then
  _ok "migrate refreshes the doctor, backing up the old copy"
else
  _bad "migrate refreshes the doctor" "the old doctor survived migrate, or no backup was written"
fi
# and the refreshed doctor must no longer report self-stale.
( cd "$R" && sh scripts/panoply.sh check ) >/dev/null 2>&1
_st=$?
if [ "$_st" != 15 ]; then
  _ok "after migrate the repo's own doctor is no longer self-stale (exit $_st)"
else
  _bad "after migrate the repo's own doctor is no longer self-stale" "still exit 15"
fi

# --- case 16 (ADVERSARIAL): a LYING STAMP is caught, and apply corrects it ----------------------
# The lying stamp is what the old apply produced on a drifted repo: it certified code that was not
# installed. A compliant repo carrying a stamp that disagrees with the kit must be reported stale, and
# apply must rewrite the stamp to the truth — never leave the lie in place.
R="$(_new_repo lyingstamp)"
_make_adopted "$R"
# The lie: claim a version the kit is not, as re-stamping a drifted repo did.
sed -i 's/^kit_version: .*/kit_version: v1.4.0/' "$R/.panoply-version"
sed -i 's/^kit_sha: .*/kit_sha: deadbeef/' "$R/.panoply-version"
assert_exit "a lying stamp is caught as stale" 12 "$R"
( cd "$R" && sh "$DOC" apply ) >/dev/null 2>&1
_stamp_after="$(sed -n 's/^kit_version:[[:space:]]*//p' "$R/.panoply-version" | head -1)"
if [ "$_stamp_after" != "v1.4.0" ] && [ "$_stamp_after" = "$("$DOC" version)" ]; then
  _ok "apply corrects a lying stamp to the kit's version ('$_stamp_after')"
else
  _bad "apply corrects a lying stamp" "stamp still says '$_stamp_after'"
fi
assert_exit "after correction the repo is current" 0 "$R"

# --- case 17 (ADVERSARIAL): the doctor must not silently skip inside a git WORKTREE -------------
# A worktree has `.git` as a FILE (a gitdir pointer), not a directory, so a `[ -d .git ]` guard reports
# "not a git working tree" and exits 0 — the check silently does not run, in exactly the environment
# parallel agent work uses. A skipped check that exits 0 is the false green this kit exists to remove.
R="$(_new_repo worktree)"
_make_adopted "$R"
# Turn the repo into a linked worktree of itself: `.git` becomes a file, the tree stays valid.
WT="$WORK/worktree-linked"
( cd "$R" && git worktree add -q "$WT" -b wt-probe ) >/dev/null 2>&1
if [ -f "$WT/.git" ]; then
  _ok "the probe really is a worktree (.git is a file)"
  # Run the DOCTOR UNDER TEST, not the worktree's own stale copy — otherwise this probe passes
  # whatever the fix does and is decoration (mutation-tested: it must go red against the old guard).
  _out="$( cd "$WT" && sh "$DOC" check 2>&1 )"
  case "$_out" in
    *"not a git working tree"*) _bad "the doctor checks inside a worktree" "skipped: $_out" ;;
    *)                          _ok "the doctor checks inside a worktree (did not skip)" ;;
  esac
else
  _bad "the worktree probe set up" "git worktree add did not produce a .git file"
fi

echo
if [ "$fail" = 0 ]; then printf 'PANOPLY.TEST: all green (%d checks)\n' "$pass"; exit 0; fi
printf 'PANOPLY.TEST: FAILED (%d ok, %d failed)\n' "$pass" "$fail"; exit 1
