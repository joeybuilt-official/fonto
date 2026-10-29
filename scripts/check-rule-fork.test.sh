#!/usr/bin/env sh
# check-rule-fork.test.sh — canary for check-rule-fork.sh.
#
# Why this exists: a drift gate that only ever reports "OK" looks identical to a gate that works, and
# one that always reports drift is the always-red gate nobody reads. This asserts BOTH directions —
# a target that silently DROPPED a policy rung is REFUSED, a target that legitimately ADAPTED (paths
# retargeted, placeholders filled, default branch named) PASSES, and a target that deliberately
# diverges with an allowlist entry is not blocked — so "detects real drift" is distinguishable from
# "blocks nothing" and from "blocks every legitimate adaptation".
#
# The fixtures build a miniature KIT (scripts/ + .agents/rules/) so the gate's "kit rules dir is
# $0/../.agents/rules" resolution is exercised exactly as in production, and a miniature TARGET with
# its own .claude/rules/. Nothing real is touched.
#
#   sh scripts/check-rule-fork.test.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE_SRC="$ROOT/scripts/check-rule-fork.sh"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t rule-fork-canary)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

[ -f "$GATE_SRC" ] || { printf 'cannot find %s\n' "$GATE_SRC" >&2; exit 2; }

# mkkit <name> — build a miniature kit whose rule modules carry the real policy anchors, and print the
# kit's ROOT dir. The runnable gate is at <kit>/scripts/check-rule-fork.sh. One clean line on stdout.
mkkit() {
  d="$TMP/$1"
  mkdir -p "$d/scripts" "$d/.agents/rules"
  cp "$GATE_SRC" "$d/scripts/check-rule-fork.sh"
  # Each anchor the gate knows must be present in the kit or the gate self-reports STALE ANCHOR
  # (exit 2) — which is correct behaviour, but it would make every downstream case meaningless, so the
  # fixture kit carries the real anchor phrases verbatim.
  cat > "$d/.agents/rules/workflow.md" <<'MD'
# Workflow
## The Algorithm pass — run before you plan, on anything structural
- **A spec precedes the plan on anything structural.** Write a spec first.
- **An agent's self-report is not review evidence.** Verify from the artifact.
MD
  cat > "$d/.agents/rules/quality-bar.md" <<'MD'
# Long-Term Quality Bar
## Ask whether the thing should exist at all, before asking how to build it well
Every plan owes a deletion candidate list.
MD
  cat > "$d/.agents/rules/git-workflow.md" <<'MD'
# Git Workflow
- **Never push directly to `{{DEFAULT_BRANCH}}`.** All work lands via a branch and a PR.
MD
  cat > "$d/.agents/rules/documentation.md" <<'MD'
# Documentation
In the SAME commit that lands work — any agent:
MD
  # The remaining always-applicable modules the anchor list guards. Each carries the real anchor phrase
  # verbatim; when the gate grows an ALWAYS anchor, this fixture grows the matching module.
  cat > "$d/.agents/rules/algorithm.md" <<'MD'
# The Algorithm: Question, Delete, Simplify, Accelerate, Automate
**Delete any part or process you can.**
**Automate only what survived steps 1–4.**
MD
  cat > "$d/.agents/rules/spec.md" <<'MD'
# Spec before Plan
**An unresolved marker must not survive into a plan.**
MD
  cat > "$d/.agents/rules/clean-architecture.md" <<'MD'
# Clean Architecture
Source-code dependencies point inward only.
MD
  cat > "$d/.agents/rules/code-style.md" <<'MD'
# Code Style & Patterns
## Before you write code
Read the module governing what you touch.
MD
  cat > "$d/.agents/rules/error-handling.md" <<'MD'
# Error Handling
## Validate at the boundaries
Every external input is untrusted.
MD
  printf '%s' "$d"
}

# mktarget <kit> <name> — build a target repo with .claude/rules/ by copying the kit's modules and
# applying the SAME legitimate adaptations Phalanx makes (retarget docs/agents -> docs/claude, fill
# the default-branch placeholder). Prints the target path.
mktarget() {
  kd="$1"; t="$TMP/$2"
  mkdir -p "$t/.claude/rules"
  # EVERY always-applicable module the anchor list guards. This set must track the gate's
  # ALWAYS_MODULES list: when the gate grows an always-module, this fixture grows it too. Otherwise a
  # legitimately adapted target looks like it dropped a rung, and case 1 fails for a reason unrelated
  # to what it is testing. (Exactly what happened going from 4 modules to 9.)
  for m in workflow quality-bar git-workflow documentation algorithm spec clean-architecture code-style error-handling; do
    sed -e 's#docs/agents/#docs/claude/#g' -e 's#{{DEFAULT_BRANCH}}#main#g' \
      "$kd/.agents/rules/$m.md" > "$t/.claude/rules/$m.md"
  done
  printf '%s' "$t"
}

# --- case 1: legitimate adaptation → PASS (positive control) -------------------
K="$(mkkit kit1)"
T="$(mktarget "$K" adapted)"
out="$(sh "$K/scripts/check-rule-fork.sh" "$T" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then ok "a legitimately adapted target passes (paths retargeted, branch filled)"
else bad "adapted target was refused (rc=$rc) — gate blocks legitimate adaptation: $out"; fi
# The positive control must pass for the RIGHT reason: every shared anchor actually compared and found.
# A gate that splits its anchor list wrongly (e.g. a literal '\t' IFS) feeds garbage module names,
# reports every module "absent", and still exits 0 — a false green. Asserting the checked COUNT closes
# that: 0 anchors checked is a broken gate, not a conforming target.
if printf '%s' "$out" | grep -qE "conforms \([1-9][0-9]* shared policy anchor"; then
  ok "conforming run names a nonzero count of anchors actually compared (not a false green)"
else bad "conforming run did not report anchors compared — gate may be a no-op: $out"; fi
if printf '%s' "$out" | grep -q "module-absent"; then
  bad "an adapted target with every module present reported module-absent (anchor parse is broken)"
else ok "adapted target reports no spurious module-absent"; fi

# --- case 2: THE REGRESSION — a policy rung silently dropped → REFUSED ---------
# This is the exact Phalanx failure: workflow.md exists but has lost the Algorithm + spec rungs.
T2="$(mktarget "$K" dropped)"
# Rewrite workflow.md keeping ONLY the harmless bits: the rung lines are deleted, module survives.
cat > "$T2/.claude/rules/workflow.md" <<'MD'
# Workflow
## Pre-flight
Read the plan doc, then the code.
MD
out="$(sh "$K/scripts/check-rule-fork.sh" "$T2" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 1 ]; then ok "a dropped policy rung is refused"
else bad "expected drift refusal for a dropped rung, rc=$rc: $out"; fi
if printf '%s' "$out" | grep -q "The Algorithm pass"; then ok "refusal names the exact missing rung (no retry loop)"
else bad "refusal does not name the missing rung: $out"; fi
if printf '%s' "$out" | grep -q "workflow"; then ok "refusal names the module that drifted"
else bad "refusal does not name the drifted module"; fi

# --- case 3: the refusal must NOT fire on a reword that keeps the point --------
# The anchor is the policy sentence; a target that keeps it verbatim (even amid other edits) passes.
T3="$(mktarget "$K" reworded)"
printf '\n- An unrelated new local rule.\n' >> "$T3/.claude/rules/quality-bar.md"
out="$(sh "$K/scripts/check-rule-fork.sh" "$T3" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then ok "local additions that keep the rung pass"
else bad "a target that kept the rung was refused, rc=$rc: $out"; fi

# --- case 4: a conditional module the target never adopted → soft, not hard -----
# Dropping a module that does not APPLY is a legitimate adapt decision and must not fail the run.
# The module must be a CONDITIONAL one: the always-applicable modules (algorithm, spec,
# clean-architecture, code-style, documentation, error-handling, quality-bar, workflow, git-workflow)
# are HARD drift when absent, since losing one silently is a policy regression. git-workflow used to be
# this case's example and no longer qualifies — a version-controlled repo that drops the git rules has
# lost policy, not made an adaptation. Case 4b asserts the always-module rule directly.
T4="$(mktarget "$K" pruned)"
printf '# Database\n## Applies when: the project owns a schema\n' > "$K/.agents/rules/database.md"
rm "$T4/.claude/rules/git-workflow.md"          # always-applicable → must be HARD
rm -f "$T4/.claude/rules/database.md"           # conditional + never copied → soft
out="$(sh "$K/scripts/check-rule-fork.sh" "$T4" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 1 ]; then ok "a dropped ALWAYS module is hard drift"
else bad "dropping git-workflow gave rc=$rc (must be 1)"; fi
if printf '%s' "$out" | grep -q "missing module: git-workflow"; then ok "the hard finding names the dropped always-module"
else bad "hard finding did not name git-workflow: $out"; fi

# --- case 5: a target with NO rule dir at all → cannot audit (exit 1, named) ---
T5="$TMP/no-rules"; mkdir -p "$T5"
out="$(sh "$K/scripts/check-rule-fork.sh" "$T5" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 1 ]; then ok "a target with no rule dir is a failure, not a silent pass"
else bad "no-rule-dir target gave rc=$rc (must not look conforming)"; fi

# --- case 6: STALE ANCHOR — the kit itself lost an anchor → exit 2 -------------
# A gate whose anchor list has rotted must say so loudly, not silently check nothing. This is the
# self-check that stops the gate from becoming a no-op after someone edits a rule heading.
K6="$(mkkit kit6)"
printf '# Workflow\n## Pre-flight\nno anchors here\n' > "$K6/.agents/rules/workflow.md"
T6="$(mktarget "$K6" stale-target)"
out="$(sh "$K6/scripts/check-rule-fork.sh" "$T6" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then ok "a rotted anchor in the kit exits 2 (gate is not a silent no-op)"
else bad "stale anchor gave rc=$rc, expected 2: $out"; fi
if printf '%s' "$out" | grep -q "STALE ANCHOR"; then ok "stale-anchor failure is named"
else bad "stale-anchor failure not named"; fi

# --- case 7: the escape hatch lifts the gate -----------------------------------
T7="$(mktarget "$K" hatch)"
cat > "$T7/.claude/rules/workflow.md" <<'MD'
# Workflow
nothing of the policy left.
MD
if ( cd "$K" && RULE_FORK_OFF=1 sh "$K/scripts/check-rule-fork.sh" "$T7" >/dev/null 2>&1 ); then
  ok "RULE_FORK_OFF=1 lifts the gate"
else bad "escape hatch did not lift the gate"; fi

# --- case 8: the gate must not mutate either tree ------------------------------
T8="$(mktarget "$K" no-mutation)"
before_t="$(find "$T8" -type f -exec cksum {} \; | sort)"
before_k="$(find "$K/.agents" -type f -exec cksum {} \; | sort)"
sh "$K/scripts/check-rule-fork.sh" "$T8" >/dev/null 2>&1 || true
after_t="$(find "$T8" -type f -exec cksum {} \; | sort)"
after_k="$(find "$K/.agents" -type f -exec cksum {} \; | sort)"
if [ "$before_t" = "$after_t" ] && [ "$before_k" = "$after_k" ]; then ok "gate mutates neither target nor kit"
else bad "gate mutated a tree it judged"; fi

# --- case 9: a target carrying an ALLOW entry is not blocked -------------------
# The allowlist is the stated-divergence path. Without it in the gate there is no way to record a
# deliberate divergence, and the only options left are a silent edit or an always-red gate.
K9="$(mkkit kit9)"
mkdir -p "$K9/.agents/rules"
# Inject an allowlist entry by rewriting the gate's ALLOW variable — a real repo would edit the same
# line. This proves the ALLOW mechanism actually short-circuits, rather than being decoration.
sed -i 's#^ALLOW=""#ALLOW="workflow|The Algorithm pass"#' "$K9/scripts/check-rule-fork.sh"
T9="$(mktarget "$K9" allowed)"
cat > "$T9/.claude/rules/workflow.md" <<'MD'
# Workflow
- **A spec precedes the plan on anything structural.** Write a spec first.
- **An agent's self-report is not review evidence.** Verify from the artifact.
MD
out="$(sh "$K9/scripts/check-rule-fork.sh" "$T9" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then ok "a divergence recorded in ALLOW is not blocked"
else bad "ALLOW entry did not short-circuit the gate, rc=$rc: $out"; fi
if printf '%s' "$out" | grep -q "allowed:workflow"; then ok "allowed divergence is reported as a soft finding"
else bad "allowed divergence not surfaced as soft"; fi

# --- case 9: COVERAGE — every always-applicable module has at least one anchor ---
# This case exists because mutation-testing found the gap: reverting the anchor list from 13 entries to
# the original 7 left the whole canary green. Coverage of the anchor list is itself a property worth
# asserting — an anchor list that silently shrinks stops guarding the modules the gate exists for, and
# nothing else in the kit would notice. Read ALWAYS_MODULES out of the gate so the two cannot diverge.
AM="$(sed -n 's/^ALWAYS_MODULES="\(.*\)"$/\1/p' "$GATE_SRC" | head -1)"
if [ -z "$AM" ]; then bad "could not read ALWAYS_MODULES from the gate"
else
  uncovered=""
  anchors_block="$(awk '/^ANCHORS=/{f=1} f{print} f&&/^EOF$/{exit}' "$GATE_SRC")"
  for m in $AM; do
    # An anchor line for this module in the gate's ANCHORS block? TAB-separated: "<module>	<phrase>".
    if printf '%s\n' "$anchors_block" | grep -q "^$m	"; then :; else uncovered="$uncovered $m"; fi
  done
  if [ -z "$uncovered" ]; then ok "every always-applicable module has at least one anchor"
  else bad "always-modules with NO anchor (silently unguarded):$uncovered"; fi
  # And the count must be plausible — 9 modules with 1-2 anchors each.
  n="$(printf '%s\n' "$anchors_block" | grep -cE '^[a-z-]+	')"
  if [ "$n" -ge 9 ]; then ok "anchor list carries $n entries (>= one per always-module)"
  else bad "anchor list has only $n entries for $(printf '%s' "$AM" | wc -w) always-modules"; fi
fi

printf '\ncheck-rule-fork canary: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
