#!/usr/bin/env sh
# check-rule-fork.sh — detect POLICY DRIFT between the kit's canonical rule modules and an adopted
# repo's rule set. Read-only audit; it never writes to either repo.
#
# WHY THIS EXISTS
#   An adopted repo (a pilot repo, and any repo that vendors the kit) keeps its own copy of the rule
#   modules — as `.claude/rules/*.md` or `.agents/rules/*.md`. That copy is legitimately ADAPTED: the
#   repo fills the kit's `{{PLACEHOLDER}}`s with real commands, retargets `docs/agents/` to its own
#   plan home, names its default branch, and drops modules that do not apply. So the two rule sets
#   will NEVER be byte-identical, and a line-for-line diff is useless — it would flag every filled
#   placeholder as drift and be red forever (the always-red gate nobody reads).
#
#   The failure this script exists for is narrower and real: a NEW policy rung the kit added AFTER the
#   repo forked is silently absent from the repo's copy. Phalanx forked before the kit grew its
#   Algorithm pass and its spec rung, so Phalanx's workflow.md silently lacks both — nothing compared
#   them, and a silent fork of governance is exactly what an adopted repo cannot detect on its own.
#
# WHAT IT CHECKS
#   A curated set of POLICY ANCHORS — one distinctive phrase per shared rule, each owned by the kit
#   module that states it. For every anchor:
#     * the kit must still carry it (else the anchor is stale and this script is wrong, not the repo);
#     * the target's copy of that module must carry it too, UNLESS an allowlist entry records the
#       divergence as intentional (a legitimate adaptation, with a stated reason).
#   An anchor that lives in a module the target does not have at all (a kit-only module) is reported
#   as `module-absent`: the repo never adopted that module. That is a soft finding, because dropping
#   a module that does not apply is a legitimate adapt decision and the target must own it.
#
#   This is DETECTION, not generation. Generating one repo's rules from another's would couple two
#   independently-published repos and could break the adopted repo's install; the two rule sets are
#   independently cited and must be able to diverge ON PURPOSE. This script only makes a divergence
#   LOUD instead of silent.
#
#   sh scripts/check-rule-fork.sh                     # audit the default target(s)
#   sh scripts/check-rule-fork.sh /path/to/repo       # audit one adopted repo
#   TARGET=/path/to/repo sh scripts/check-rule-fork.sh
#   RULE_FORK_OFF=1 sh scripts/check-rule-fork.sh     # escape hatch (adoption in progress)
#
# Exit: 0 = no policy drift; 1 = real drift (a shared anchor is missing with no allowlist excuse);
#       2 = the audit could not run (kit or target not found). POSIX sh, no runtime deps.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The kit's canonical modules. Prefer .agents/rules/ (the source), fall back to .claude/rules/ so the
# script also works from inside an adapted repo that vendored the kit under the Claude path.
KIT_RULES=""
for d in "$ROOT/.agents/rules" "$ROOT/.claude/rules"; do
  [ -d "$d" ] && { KIT_RULES="$d"; break; }
done
[ -n "$KIT_RULES" ] || { echo "check-rule-fork: no kit rule dir (.agents/rules or .claude/rules) under $ROOT" >&2; exit 2; }

# Escape hatch — an adopted repo mid-migration states it rather than being silently exempt.
if [ "${RULE_FORK_OFF:-0}" = "1" ]; then
  echo "check-rule-fork: RULE_FORK_OFF=1 — drift check skipped (adoption in progress)"
  exit 0
fi

# --- targets -----------------------------------------------------------------
# One adopted repo, resolved from $1 / $TARGET / the default below. A target may keep its rules under
# either path; the first that exists wins.
if [ "${1:-}" != "" ]; then
  TARGETS="$1"
elif [ "${TARGET:-}" != "" ]; then
  TARGETS="$TARGET"
else
  # The kit's own tree is not a "target" (it IS the source). Default to the known adopted repo.
  TARGETS="${REPOS:-<workspace>/a pilot repo}"
fi

# --- policy anchors ----------------------------------------------------------
# Tab-separated: <module><TAB><anchor>. One anchor per line. Each anchor is a distinctive phrase the
# KIT module states and that a fork must not silently lose. Keep each anchor SHORT and UNIQUE to its
# policy point — a phrase that survives placeholder-filling and path-retargeting (no {{TOKENS}}, no
# docs/agents paths, no branch names), so a filled-in copy still matches it. A fork that rewords the
# rule entirely will still trip this — that is intended: a silent reword of a policy point is exactly
# the fork this guards against, and the cure is an allowlist entry stating the divergence was
# deliberate.
#
# COVERAGE RULE: every module whose "Applies when" line says ALWAYS needs an anchor, because losing one
# silently is a policy regression no other gate sees. Nine modules are always-applicable today. The
# list previously covered only four, so a fork could drop `algorithm.md` and `spec.md` wholesale and
# still return rc=0 "no policy drift" — the exact failure this script's own header cites. Conditional
# modules (database, frontend, api-design, …) are legitimately absent from a repo that does not apply
# them, so they stay `module-absent` (soft), not drift.
ANCHORS="$(cat <<'EOF'
workflow	The Algorithm pass
workflow	A spec precedes the plan on anything structural
workflow	An agent's self-report is not review evidence
quality-bar	Ask whether the thing should exist at all
quality-bar	deletion candidate list
git-workflow	Never push directly to
documentation	SAME commit that lands work
algorithm	Automate only what survived steps 1
algorithm	Delete any part or process you can
spec	An unresolved marker must not survive into a plan
clean-architecture	dependencies point inward
code-style	Before you write code
error-handling	Validate at the boundaries
EOF
)"

# --- allowlist ---------------------------------------------------------------
# A divergence recorded here is INTENTIONAL and carries its reason. Keyed "<module>|<anchor>". Keep
# the reason long enough to be reviewable: an allowlist entry with no reason is the silent-exemption
# failure mode this whole script exists to prevent.
#
# Empty today: Phalanx's only diffs on these anchors are MISSING policy (real drift), not legitimate
# divergences. When a repo deliberately drops or rewords a rung, add the entry here with its reason.
ALLOW=""

# normalise <file> — join lines with spaces and squeeze whitespace runs to one space, so a phrase
# matches across a line wrap or a blockquote marker. Prints to stdout.
normalise() {
  tr '\n' ' ' < "$1" | tr -s ' \t' ' '
}

# has_anchor <file> <anchor> — true if the normalised file contains the anchor literal (fixed string).
has_anchor() {
  normalise "$1" | grep -Fq "$2"
}

# is_allowed <key> — true if an allowlist entry matches the "<module>|<anchor>" key.
is_allowed() {
  printf '%s\n' "$ALLOW" | grep -Fq "$1"
}

# ALWAYS_MODULES — the modules that apply to EVERY repo (their "Applies when" line says so). A target
# missing one of these has lost a policy rung, not made an adaptation decision; so absence is HARD.
# Everything else may legitimately be unadopted, and stays a soft `module-absent`.
ALWAYS_MODULES="algorithm spec clean-architecture code-style documentation error-handling quality-bar workflow git-workflow"

is_always_module() {
  for _m in $ALWAYS_MODULES; do [ "$_m" = "$1" ] && return 0; done
  return 1
}

# module_file <dir> <module> — print the module's path in a rule dir, or nothing.
module_file() {
  if [ -f "$1/$2.md" ]; then printf '%s' "$1/$2.md"; return 0; fi
  return 1
}

fail=0
unaudited=0

for target in $TARGETS; do
  tdir=""
  for d in "$target/.claude/rules" "$target/.agents/rules"; do
    [ -d "$d" ] && { tdir="$d"; break; }
  done
  if [ -z "$tdir" ]; then
    # A sibling with no rules directory is NOT drift: there was nothing to compare against, so the
    # comparison never happened. Reporting it as "drift detected" asserts a finding the run did not
    # establish — the same defect as a doctor saying "applied and current" without comparing contents.
    # Three different facts need three different verdicts: drift found, nothing to compare, and the
    # audit itself failing. This is the second of those, and it renders as itself.
    echo "check-rule-fork: $target has no .claude/rules or .agents/rules — NOT AUDITED (nothing to compare)" >&2
    unaudited=$((unaudited + 1))
    continue
  fi

  hard=""; soft=""; checked=0

  # Read anchors through a redirected here-doc (NOT a pipe) so the loop body runs in THIS shell and
  # can set `hard`/`fail` — a piped `while` would set them in a subshell and vanish. IFS must be a REAL
  # tab, not '	': a quoted '	' is a literal backslash + t, which splits every line on those characters
  # and feeds garbage module names to the checks below (a silent false green, not a crash).
  TAB="$(printf '	')"
  while IFS="$TAB" read -r mod anchor; do
    [ -n "$mod" ] || continue
    [ -n "$anchor" ] || continue

    # 1. The kit must still carry the anchor — else the anchor is stale (script bug), not target drift.
    kf="$(module_file "$KIT_RULES" "$mod" || true)"
    if [ -n "$kf" ] && ! has_anchor "$kf" "$anchor"; then
      echo "check-rule-fork: STALE ANCHOR — kit '$mod' no longer carries: $anchor" >&2
      exit 2
    fi

    # 2. The target's copy must carry it too, unless the divergent module is absent or allowed.
    tf="$(module_file "$tdir" "$mod" || true)"
    if [ -z "$tf" ]; then
      # ABSENCE IS HARD DRIFT WHEN THE MODULE ALWAYS APPLIES. A conditional module (database, frontend,
      # api-design, …) legitimately may not be adopted, so its absence stays soft. But algorithm, spec,
      # clean-architecture, code-style, documentation, error-handling, quality-bar, workflow and
      # git-workflow apply to EVERY repo — dropping one is a policy regression, and reporting it as
      # mere `soft` made it invisible: a fork with those modules deleted returned rc=0 "no policy
      # drift", which is precisely the failure this script exists to catch.
      if is_always_module "$mod"; then
        hard="$hard
    missing module: $mod (always-applicable — the whole rung is gone from $tdir)"
      else
        soft="$soft module-absent:$mod"
      fi
      continue
    fi
    if has_anchor "$tf" "$anchor"; then
      checked=$((checked + 1))
      continue
    fi
    if is_allowed "$mod|$anchor"; then
      soft="$soft allowed:$mod"
      continue
    fi
    hard="$hard
    missing in $mod: $anchor"
  done <<EOF
$ANCHORS
EOF

  label="$(basename "$target")"
  if [ -n "$hard" ]; then
    echo "check-rule-fork: POLICY DRIFT in $label — shared rung(s) missing from $tdir:"
    printf '%s\n' "$hard"
    echo "    fix: port the rung into $tdir, or record the divergence in the ALLOW list with a reason." >&2
    fail=1
  fi
  if [ -n "$soft" ]; then
    for s in $soft; do printf '  soft: %s\n' "$s"; done
  fi
  [ -n "$hard" ] || echo "check-rule-fork: $label conforms ($checked shared policy anchor(s) present)."
done

if [ "$fail" -eq 1 ]; then
  echo "check-rule-fork: drift detected — see above; this script is read-only and changed nothing." >&2
  exit 1
fi
if [ "$unaudited" -gt 0 ]; then
  # Distinct from both "drift" and "clean": the run established LESS than a clean result would imply.
  echo "check-rule-fork: no drift found, but $unaudited sibling(s) could not be audited — this is not a clean bill." >&2
  exit 1
fi
echo "check-rule-fork: no policy drift." >&2
