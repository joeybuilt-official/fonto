#!/usr/bin/env sh
# check-expert-review.test.sh — canary for the expert-review gate.
#
# The gate had no test at all, which is how its fail-open on an unresolvable diff base went unnoticed:
# `git rev-list <bad-ref>..HEAD` errors, the loop body never runs, and the gate reports OK. In CI that
# is a gate that silently stops guarding the checkout it exists to guard.
#
# Asserts both directions, per the kit's gate doctrine: a missing base REFUSES (exit 2, not 0), a real
# base behaves, and the escape hatch lifts it. POSIX sh, no runtime deps.
#
# It also carries the ADVERSARIAL case the gate existed without: a repo holding a plan + checklist for
# feature A, then a PR that is a large change to feature B with no plan of its own. The old gate was
# tree-global — `find docs/agents -name plan.md` and a tree-wide checklist grep — so it went GREEN on
# exactly that PR. The canary now pins the change-scoped rule by proving the old behaviour is refused.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-expert-review.sh"
pass=0
fail=0

ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

mk_repo() {
  r="$TMP/$1"; mkdir -p "$r/scripts"
  cp "$GATE" "$r/scripts/"
  git -C "$r" init -q
  # Commit the gate itself so it is NOT part of any later change under test. Otherwise a base taken
  # at the root commit sees scripts/check-expert-review.sh as an added source file and every fixture
  # reads as structural for the wrong reason.
  git -C "$r" add -A
  git -C "$r" -c user.email=t@t -c user.name=t commit -q -m "chore: install gate"
  printf '%s\n' "$r"
}

root_sha() { git -C "$1" rev-list --max-parents=0 HEAD; }
head_sha() { git -C "$1" rev-parse HEAD; }

commit_all() { git -C "$1" add -A; git -C "$1" -c user.email=t@t -c user.name=t commit -q -m "$2"; }

# a plan doc for feature <slug>, carrying a checklist line — the evidence the gate looks for
mk_plan() {
  r="$1"; area="$2"; slug="$3"
  mkdir -p "$r/docs/agents/$area/$slug"
  {
    printf '# Plan: %s\n\n' "$slug"
    printf '## Milestones\n\n'
    printf -- '- [ ] do the work\n'
    printf -- '- [x] scope it\n'
  } > "$r/docs/agents/$area/$slug/plan.md"
}

# --- case 1: an unresolvable base REFUSES (the regression this file exists for) ---
r="$(mk_repo bad-base)"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since deadbeefdeadbeef ) 2>&1 )" && rc=ok || rc=$?
if [ "$rc" = "2" ]; then ok "unresolvable --since base refuses with exit 2 (was: silently OK)"
else bad "unresolvable base must exit 2, got '$rc' — a gate that reports OK here guards nothing"; fi
if printf '%s' "$out" | grep -q "does not resolve"; then ok "refusal names the real cause"
else bad "refusal message does not explain the unresolvable base: $out"; fi

# --- case 2: a resolvable base does NOT produce the refusal (positive control) ---
r="$(mk_repo good-base)"; base="$(root_sha "$r")"
mkdir -p "$r/docs/claude"; printf -- '- note\n' > "$r/docs/claude/worklog.md"
printf 'a\n' > "$r/planish.md"
git -C "$r" add -A; git -C "$r" -c user.email=t@t -c user.name=t commit -q -m "docs: note"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=ok || rc=$?
if [ "$rc" != "2" ]; then ok "a resolvable base does not trigger the refusal (exit $rc)"
else bad "resolvable base wrongly refused: $out"; fi

# --- case 3: the escape hatch lifts the gate ---
r="$(mk_repo hatch)"
if ( cd "$r" && EXPERT_REVIEW_OFF=1 sh scripts/check-expert-review.sh --since deadbeefdeadbeef >/dev/null 2>&1 ); then
  ok "EXPERT_REVIEW_OFF=1 lifts the gate (declared exception)"
else bad "escape hatch did not lift the gate"; fi

# === THE ADVERSARIAL CASE =====================================================
# A repo that already contains feature A's plan + checklist, then a LARGE change to feature B that
# carries no plan of its own. The old tree-global gate went green here. It must now fail.

# --- case 4: feature-A plan in the tree, large unreviewed feature-B change -> REFUSED ----------
r="$(mk_repo adversarial-unrelated-plan)"
mk_plan "$r" core feature-a
commit_all "$r" "plan(feature-a): finish feature a"
base="$(head_sha "$r")"
i=0; while [ "$i" -lt 20 ]; do
  j=0; while [ "$j" -lt 15 ]; do printf 'x\n'; j=$((j+1)); done > "$r/src_b_$i.md.tmp"
  i=$((i+1))
done
mkdir -p "$r/src"; i=0; while [ "$i" -lt 20 ]; do
  mv "$r/src_b_$i.md.tmp" "$r/src/b_$i.sh"; i=$((i+1))
done
commit_all "$r" "feat(feature-b): big change, no plan of its own"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" = "1" ]; then
  ok "ADVERSARIAL: feature-B change with only feature-A's plan in the tree is REFUSED (exit 1)"
else
  bad "ADVERSARIAL: gate passed a large unreviewed change because an unrelated plan exists (exit $rc) — the tree-global defect is back"
fi
if printf '%s' "$out" | grep -q "no review evidence"; then ok "ADVERSARIAL: refusal names missing review evidence"
else bad "ADVERSARIAL: refusal message wrong: $out"; fi

# --- case 5: positive control — the SAME change passes once it touches a plan of its own --------
# Without this, case 4 would also go green if the gate simply refused everything.
mk_plan "$r" core feature-b
commit_all "$r" "plan(feature-b): plan for the big change"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" = "0" ]; then ok "ADVERSARIAL: the same change passes once its own plan is part of it (exit 0)"
else bad "ADVERSARIAL: gate refused a change that DOES carry its own plan: $out"; fi

# --- case 6: a plan for feature B sits in the tree but the PR never touches it -> REFUSED --------
r="$(mk_repo adversarial-untouched-plan)"
mk_plan "$r" core feature-b
commit_all "$r" "plan(feature-b): write the plan ahead of time"
base="$(head_sha "$r")"
mkdir -p "$r/src"; i=0; while [ "$i" -lt 10 ]; do printf 'y\n' > "$r/src/f$i.sh"; i=$((i+1)); done
commit_all "$r" "feat(feature-b): implement, but never touch the plan"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" = "1" ]; then
  ok "ADVERSARIAL: an in-tree-but-untouched plan is not evidence (exit 1)"
else
  bad "ADVERSARIAL: gate accepted a plan merely PRESENT in the tree, not touched by the change (exit $rc)"
fi

# --- case 7: a touched plan with NO checklist line is refused (second half of the scope fix) -----
r="$(mk_repo no-checklist)"
base="$(root_sha "$r")"
mkdir -p "$r/src"; printf 'z\n' > "$r/src/a.sh"
mkdir -p "$r/docs/agents/core/feature-c"
printf '# Plan: feature-c\n\nNo checklist here.\n' > "$r/docs/agents/core/feature-c/plan.md"
commit_all "$r" "feat(feature-c): add plan with no checklist"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" = "1" ]; then ok "a touched plan without a checklist line is refused (exit 1)"
else bad "gate accepted a plan carrying no checklist: $out"; fi

# --- case 7b: ADVERSARIAL — the touched plan has no checklist, but an UNRELATED completed plan
#             elsewhere in docs/ does. The old tree-global checklist grep (`grep -rl docs/agents`)
#             went GREEN here. The scope fix must still refuse: the checklist must be in the plan
#             the change touched, not merely somewhere in the repo. -------------------------------
r="$(mk_repo no-checklist-but-other)"
mk_plan "$r" core feature-a          # feature A: a completed plan WITH a checklist
commit_all "$r" "plan(feature-a): finished earlier"
base="$(head_sha "$r")"
mkdir -p "$r/src"; printf 'z\n' > "$r/src/b.sh"
mkdir -p "$r/docs/agents/core/feature-c"
printf '# Plan: feature-c\n\nNo checklist here.\n' > "$r/docs/agents/core/feature-c/plan.md"
commit_all "$r" "feat(feature-c): add plan with no checklist of its own"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" = "1" ]; then
  ok "ADVERSARIAL: an unrelated checklist elsewhere does not satisfy the touched plan (exit 1)"
else
  bad "ADVERSARIAL: gate accepted a checklist from an unrelated plan — the tree-global checklist grep is back (exit $rc)"
fi

# --- case 8: a docs-only change is exempt even with no plan anywhere (no ceremony) ---------------
r="$(mk_repo docs-only)"
base="$(root_sha "$r")"
mkdir -p "$r/docs"; printf 'note\n' > "$r/docs/notes.md"
printf '# ruled\n' > "$r/CONVENTIONS.md"
commit_all "$r" "docs: note only"
out="$( ( cd "$r" && sh scripts/check-expert-review.sh --since "$base" ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" = "0" ]; then ok "docs-only change is exempt (exit 0)"
else bad "docs-only change wrongly refused: $out"; fi

printf '\ncheck-expert-review canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
