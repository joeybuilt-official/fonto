#!/usr/bin/env sh
# panoply.sh — the Panoply kit's machine surface: detect, report, and seed.
#
# Why this exists: the kit could only be applied by a slash-command prompt
# (`.agents/commands/adapt-agents-setup.md`), and nothing recorded WHICH kit version a repo
# received. So "not applied" and "applied in July" were indistinguishable to every agent, and kit
# drift was invisible. This script is the check/apply entry point any agent or CI can run: Hermes,
# any agent, a cron, a pre-commit hook.
#
#   sh scripts/panoply.sh check [--quiet]   exit 0 = current, non-zero = action needed
#   sh scripts/panoply.sh apply [--yes] [--force-scripts]   seed/refresh the DETERMINISTIC half
#   sh scripts/panoply.sh migrate [--yes]   translate an OLD-layout adopter onto the current layout
#   sh scripts/panoply.sh stamp             write/refresh .panoply-version only
#   sh scripts/panoply.sh version           print this kit's version
#
# Exit codes (check): 0 current · 10 absent · 11 partial · 12 stale · 13 placeholders left · 14 mirrors
#                     drifted · 15 the CHECK ITSELF is stale (see below)
# Env: PANOPLY_OFF=1 disables the check entirely (adopting repo mid-migration).
#
# 15 — SELF-STALE. The doctor cannot detect that IT is the stale party by inspecting the repo, because
# it only knows its own embedded expectations. So it embeds a GENERATION marker and, when it can reach
# a kit source, compares its marker against the source's. A copy that disagrees is stale and says so,
# rather than printing a clean bill of health against an obsolete layout — the false green this state
# exists to kill. When no kit source is reachable the doctor refuses to fail open: it reports that it
# cannot verify (exit 15) instead of treating its own assumptions as proof.
#
# The generation marker is compared, never the version string: between releases both the copy and the
# source report `unreleased`, so a version comparison detects nothing in the exact case (a kit between
# tags) where the false green appears. The marker changes exactly when the doctor's layout expectation
# changes, which is what "this copy is stale" means. See docs/agents/governance/completed/kit-self-update/plan.md.


set -eu

# ---------------------------------------------------------------- version ----
# The kit's version is the KIT SOURCE's own semver tag — resolved from this script's location, never
# from the repo under inspection (a consumer repo's tags are unrelated, and resolving them silently
# reports another project's version). Falls back to the latest tag, then "unreleased".
_kit_root() { cd "$(dirname "$0")/.." && pwd; }

# A canonical kit clone, used when this script has been COPIED into an adopted repo.
_canonical_kit_root() {
  for _c in "${PANOPLY_KIT_ROOT:-}" "${HOME:-}/.panoply" "${HOME:-}/.cache/panoply" "${HOME:-}/panoply"; do
    [ -n "$_c" ] || continue
    if [ -f "$_c/scripts/panoply.sh" ]; then printf '%s' "$_c"; return 0; fi
  done
  return 1
}

# True when this script is a COPY living inside an adopted repo rather than the kit source itself.
# `apply` copies the doctor into the repo so the repo can self-check; the tell is a stamp sitting
# next to us (the kit source never carries one — it IS the source).
_is_copied_doctor() { [ -f "$(_kit_root)/$(printf '.panoply-version')" ]; }

# The repo whose tags define the KIT's version. From a copied doctor, `$0`'s directory is the
# ADOPTER, whose tags are unrelated to the kit's: resolving from it made a compliant repo mismatch
# its own product tag against the stamp and report "stale" forever — an always-red gate. So the
# copied doctor never reads tags at all — see _kit_version.
_kit_source_root() { _canonical_kit_root; }

# The KIT's version. ONE question, answered the same way in both trees: **what release does this
# checkout correspond to?**
#
# The bug this replaces: the source answered "what release is this?" with `git describe --tags
# --abbrev=0`, while a copied doctor answered "what is the nearest ancestor tag?" from a canonical
# clone. Those are different questions, and they disagree whenever the kit sits between releases —
# a checkout 14 commits past `v1.4.0` describes as `v1.4.0-14-gc0dee04`, which the guard below then
# reported as a version rather than `unreleased`, while the same commit in the canonical clone
# (where `--abbrev=0` strips the `-14-g` suffix) reported the bare `v1.4.0`. `apply` therefore
# stamped one value and the copied doctor reported another.
#
# The divergence only appeared where a canonical clone existed — a local-only false red in the one
# gate adopters are told to run, and invisible on a fresh CI runner. Fixing it by making the source
# mirror the clone's behaviour would have propagated the wrong question; instead a version comes
# from a TAG ONLY WHEN HEAD IS EXACTLY AT IT (`--exact-match`), so an untagged checkout is
# `unreleased` in every tree. Tagged releases are unaffected.
_kit_version() {
  if _is_copied_doctor; then
    # A copied doctor does not read tags at all. The stamp was written by the kit source at apply
    # time using the rule below, so it is the authoritative answer, and reading the canonical
    # clone's tags here is what produced the mismatch.
    v="$(sed -n 's/^kit_version:[[:space:]]*//p' "$(_kit_root)/$(printf '.panoply-version')" 2>/dev/null | head -1)"
    [ -n "$v" ] || v="unreleased"
    printf '%s' "$v"
    return 0
  fi
  _r="$(_kit_root)"
  v="$(git -C "$_r" describe --tags --exact-match 2>/dev/null || true)"
  [ -n "$v" ] || v="unreleased"
  printf '%s' "$v"
}

_kit_sha() {
  _r="$(_kit_source_root || true)"
  if [ -n "$_r" ]; then git -C "$_r" rev-parse --short HEAD 2>/dev/null && return 0; fi
  if _is_copied_doctor; then
    sed -n 's/^kit_sha:[[:space:]]*//p' "$(_kit_root)/$(printf '.panoply-version')" 2>/dev/null | head -1
    return 0
  fi
  printf 'unknown'
}

# ---------------------------------------------------------------- markers ----
# The triad. Absent = never applied. Partial = a half-applied kit, which the kit's own docs call out
# as the failure mode that "looks like a doc bug" (dead refs, missing spine).
_REQUIRED_AGENTS="AGENTS.md"
_REQUIRED_SPINE="docs/agents/roadmap.md"
_REQUIRED_RULES=".agents/rules/clean-architecture.md"
_MARKER_MIRROR="MIRROR:start"
_MARKER_RULES="PANOPLY:RULES:BEGIN"

# The GENERATION marker — the answer to "is THIS copy of the doctor stale?". It changes exactly when
# the doctor's embedded layout expectation (the _REQUIRED_* paths above and the states it can report)
# changes. A copy and a source that disagree on this value are two different kit generations, and the
# older one must say so rather than validate a repo against an obsolete layout.
#
# Bump this string when you change _REQUIRED_* , the exit-code table, or the set of states — i.e. when
# a copied doctor from before the change would validate the wrong thing.
_PANOPLY_GENERATION="layout-agents-2"   # v1: docs/claude + .claude/rules ; v2: docs/agents + .agents/rules

_stamp_file() { printf '.panoply-version'; }

# The generation marker embedded in a given copy of this script, read textually so the doctor never has
# to execute another copy. Prints the marker, or nothing when the file carries none (a pre-marker kit
# generation, which is itself the tell that it is stale).
_generation_of_file() {
  [ -f "$1" ] || return 1
  sed -n 's/^_PANOPLY_GENERATION="\([^"]*\)".*/\1/p' "$1" | head -1
}

# The generation marker the REACHABLE kit source was built for, or nothing when no source is reachable.
# Read from the file, not by running it: `sh source check` would inspect THIS repo, not answer "which
# generation are you?", and a source that fails to run must not be silently treated as absent.
_source_generation() {
  _r="$(_canonical_kit_root || true)"
  [ -n "$_r" ] || return 1
  _g="$(_generation_of_file "$_r/scripts/panoply.sh" || true)"
  [ -n "$_g" ] || return 1
  printf '%s' "$_g"
}


# ---------------------------------------------------------------- inspect ----
# Reads the repo in the CWD. Prints findings to stderr, and a machine-readable line to stdout.
# Emits: STATUS<tab>detail
_inspect() {
  _status="current"
  _reason=""

  # SELF-STALE is checked FIRST, and dominates every other verdict. A doctor built for an older layout
  # validates the repo against expectations the current kit no longer holds, so its "current"/"partial"
  # verdict is meaningless — this is the false-green the state exists to kill. It must therefore win
  # over whatever the (obsolete) triad check concluded, including a would-be "current".
  #
  # TWO independent tells, because the false green appears in two situations:
  #
  #   a. THE RUNNING COPY CARRIES NO MARKER. A pre-marker kit generation has no `_PANOPLY_GENERATION`
  #      anywhere in its script, so reading it off $0 yields nothing. This is the owner-verified case:
  #      an old adopter running its OWN copy, with NO kit source reachable at all. Detecting it needs no
  #      source — the copy's own silence is the tell — which is exactly why a version-string comparison
  #      (both sides `unreleased`) never caught it.
  #   b. A REACHABLE SOURCE DISAGREES. When the doctor can reach a kit source, a generation mismatch is
  #      positive proof of staleness, and names both generations in the message.
  #   c. THE REPO'S OWN COMMITTED COPY DISAGREES. A repo that adopted an older kit carries that older
  #      doctor at scripts/panoply.sh. Any modern doctor — run from the kit in CI, or by a maintainer —
  #      reads that file's generation and reports self-stale when it differs from the running one. This
  #      is the tell that catches the existing old-layout adopters TODAY: the copy they run is the
  #      problem, and the running doctor can see it even though the stale copy cannot see itself.
  #
  # The template repo itself is exempt: the kit checking itself IS the source, not a copy, and must not
  # report itself stale against a canonical clone that may lag.
  _selfstale=0
  if [ ! -f scripts/init-template-repo.sh ] || [ ! -f .agents/commands/adapt-agents-setup.md ]; then
    _mygen="$(_generation_of_file "$0" || true)"
    _srcgen="$(_source_generation || true)"
    _repogen="$(_generation_of_file scripts/panoply.sh || true)"
    if [ -z "$_mygen" ]; then
      # This doctor predates the marker: it is the stale party, whatever it is inspecting.
      _selfstale=1
      _reason="this doctor carries no generation marker — it predates kit generation '$_PANOPLY_GENERATION' and validates a layout the current kit no longer uses. Refresh it: sh scripts/panoply.sh migrate"
    elif [ -n "$_srcgen" ] && [ "$_srcgen" != "$_mygen" ]; then
      _selfstale=1
      _reason="this doctor is generation '$_mygen' but the kit source is '$_srcgen' — the copy is stale; refresh it (sh scripts/panoply.sh migrate)"
    elif [ -f scripts/panoply.sh ] && ! cmp -s "$0" scripts/panoply.sh && [ -z "$_repogen" ]; then
      # The repo's committed doctor predates the marker while THIS doctor carries one: the repo is
      # running an old copy. Reported whether or not a kit source is reachable — the repo file is the
      # proof, no network or clone needed.
      _selfstale=1
      _reason="the repo's own scripts/panoply.sh carries no generation marker (an older kit generation) while this check is '$_mygen' — the repo is running a stale doctor; refresh it (sh scripts/panoply.sh migrate)"
    fi
    # No source reachable but the running copy carries the CURRENT generation: it can trust its own
    # layout, so it proceeds — and says out loud that the check was not cross-verified, rather than
    # staying silent about it (a quiet assumption is how the old false green worked).
    if [ "$_selfstale" = "0" ] && [ -z "$_srcgen" ]; then
      printf 'panoply: note — no kit source reachable; checked against this copy'"'"'s own generation (%s), not cross-verified\n' "$_mygen" >&2
    fi
  fi
  if [ "$_selfstale" = "1" ]; then
    printf 'selfstale\t%s\n' "$_reason"
    return 0
  fi

  for _f in "$_REQUIRED_AGENTS" "$_REQUIRED_SPINE" "$_REQUIRED_RULES"; do
    if [ ! -f "$_f" ]; then
      _status="partial"
      _reason="missing $_f"
      # Nothing at all present => absent, not partial.
      if [ ! -f "$_REQUIRED_AGENTS" ] && [ ! -d docs/agents ] && [ ! -d .agents/rules ]; then
        _status="absent"
        _reason="no kit markers found"
      fi
      break
    fi
  done

  # Placeholders surviving anywhere in the kit surface => the kit was copied but never adapted.
  # Only ADOPTED repos can be "unadapted": the template repo itself is legitimately full of tokens,
  # so it is excluded. Without this exclusion the kit reports itself broken on every run, which is
  # exactly the kind of always-red gate people learn to ignore.
  # Self-detection: only the template repo ships scripts/init-template-repo.sh (it is the script that
  # published the template). PANOPLY_SELF=1 forces the exclusion; PANOPLY_SELF=0 forces the check.
  _self=0
  case "${PANOPLY_SELF:-auto}" in
    1) _self=1 ;;
    0) _self=0 ;;
    *)
      # NOTE: an `A && B && C=1` chain here would return non-zero when the tests fail, and `set -e`
      # would abort the whole check on a repo that merely is not the template. Use an if.
      if [ -f scripts/init-template-repo.sh ] && [ -f .agents/commands/adapt-agents-setup.md ]; then
        _self=1
      fi
      ;;
  esac
  if [ "$_status" = "current" ] && [ "$_self" != "1" ]; then
    # Only ADAPT-TIME tokens count. The kit's docs legitimately discuss its own convention using the
    # metasyntax ({{DOUBLE_BRACES}}, {{TOKEN}}, {{PROJECT_NAME}} in prose), so matching any run of
    # capital letters flags every correctly-adopted repo as unadapted — the always-red failure the
    # canary caught. An unfilled token is a NAME-like placeholder; prose metasyntax is not.
    _ph="$(grep -rlE '\{\{(PROJECT_NAME|ONE_LINE_DESCRIPTION|CORE_PILLARS|DEFAULT_BRANCH|PKG_MANAGER|LANGUAGE_RUNTIME|INSTALL_CMD|DEV_CMD|BUILD_CMD|TEST_CMD|LINT_CMD|FORMAT_CMD|TYPECHECK_CMD|COVERAGE_CHECK_CMD|CLIENT_STACK|SERVER_STACK|DATABASE_STACK|MONOREPO_LAYOUT|PROJECT_STRUCTURE|TEST_DIR|ENDPOINT_SRC_DIR|DOMAIN_DIR|USECASE_DIR|ADAPTER_DIR|INFRA_DIR|UI_PRIMITIVES_DIR|DOMAIN_COMPONENTS_DIR|PAGES_DIR|SCHEMA_FILE|MIGRATE_GEN_CMD|MIGRATE_APPLY_CMD|EXPORT_STYLE|FILE_NAMING|IMPORT_ALIAS|SHARED_CONSTANTS_PATH|API_WRAPPER|DATA_ACCESS_LAYER|DATA_FETCH_LIB|UI_FRAMEWORK|STYLING_SYSTEM|ICON_LIBRARY|ICON_SIZE|DESIGN_REFERENCE|AESTHETIC_FAMILY|CHROME_WEIGHT|PALETTE_STRATEGY|DENSITY|MOTION_INTENSITY|DEFAULT_TEXT_SIZE|SECTION_HEADER|FIELD_LABEL|FIELD_VALUE|SECTION_PADDING|ELEMENT_GAP|BORDER_TREATMENT|ARCH_CHECK_CMD|MIGRATE_[A-Z_]+|[A-Z_]*_CMD)\}\}' \
      AGENTS.md docs/agents .agents/rules 2>/dev/null | head -5 || true)"
    if [ -n "$_ph" ]; then
      _status="placeholders"
      _reason="unfilled adapt tokens in: $(printf '%s' "$_ph" | tr '\n' ' ')"
    fi
  fi

  # Stamp missing or behind the kit version => stale (applied, but not the current kit).
  # The template repo itself carries no stamp: it IS the source, not an adopter.
  if [ "$_status" = "current" ] && [ "$_self" != "1" ]; then
    _want="$(_kit_version)"
    if [ ! -f "$(_stamp_file)" ]; then
      _status="stale"
      _reason="no $(_stamp_file) stamp (applied before stamping existed, or hand-copied)"
    else
      _got="$(sed -n 's/^kit_version:[[:space:]]*//p' "$(_stamp_file)" | head -1)"
      if [ -n "$_got" ] && [ "$_got" != "$_want" ]; then
        _status="stale"
        _reason="stamp says $_got, kit is $_want"
      fi
    fi
  fi

  # Mirrors drifted from their modules => the generated files no longer match the rule bodies.
  if [ "$_status" = "current" ] && [ -f scripts/sync-agents.sh ]; then
    if ! sh scripts/sync-agents.sh --check >/dev/null 2>&1; then
      _status="drifted"
      _reason="generated mirrors out of sync with .agents/rules (run: sh scripts/sync-agents.sh)"
    fi
  fi

  printf '%s\t%s\n' "$_status" "$_reason"
}

# ---------------------------------------------------------------- commands ----
cmd_version() { _kit_version; printf '\n'; }

# cmd_stamp: record what was applied. A stamp must CERTIFY THE STATE, not the attempt.
#
# The defect this fixes: `apply` on a repo whose managed scripts had drifted kept every local copy,
# changed nothing, and still rewrote the stamp to the kit's current version — so the stamp certified
# code that was not installed, and a later `check` on that stamp is a green over a drifted tree. The
# caller passes `_panoply_drifted=1` when it left managed files differing from the kit; the stamp then
# records a NON-CURRENT version (`<version>+drifted`) instead of claiming current, so the drift is
# visible in the very file readers trust. `stamp` invoked directly (no drift context) is unchanged.
cmd_stamp() {
  _v="$(_kit_version)"; _s="$(_kit_sha)"
  if [ "${_panoply_drifted:-0}" = "1" ]; then
    _v="${_v}+drifted"
  fi
  {
    printf '# panoply kit stamp — written by scripts/panoply.sh (do not hand-edit)\n'
    printf 'kit_version: %s\n' "$_v"
    printf 'kit_sha: %s\n' "$_s"
    printf 'applied_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'applied_by: %s\n' "${PANOPLY_APPLIED_BY:-unknown-agent}"
  } > "$(_stamp_file)"
  if [ "${_panoply_drifted:-0}" = "1" ]; then
    printf 'stamped %s at %s (%s) — DRIFTED: the stamp does NOT certify the current kit (%s)\n' \
      "$(_stamp_file)" "$_v" "$_s" \
      "managed files differ from the kit; review and re-run apply"
  else
    printf 'stamped %s at %s (%s)\n' "$(_stamp_file)" "$_v" "$_s"
  fi
}

cmd_check() {
  _quiet=0
  for a in "$@"; do [ "$a" = "--quiet" ] && _quiet=1; done

  if [ "${PANOPLY_OFF:-0}" = "1" ]; then
    printf 'panoply: OFF (PANOPLY_OFF=1) — check skipped\n' >&2
    exit 0
  fi
  # A git WORKTREE has `.git` as a FILE (a gitdir pointer), not a directory — as do submodules.
  # Testing `[ -d .git ]` therefore reports "not a git working tree" inside every worktree and exits 0,
  # silently skipping the check in exactly the environment parallel agent work uses. Ask git instead.
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'panoply: not a git working tree (nothing to check)\n' >&2
    exit 0
  fi

  _out="$(_inspect)"
  _st="$(printf '%s' "$_out" | cut -f1)"
  _why="$(printf '%s' "$_out" | cut -f2)"

  _ver="$(_kit_version)"
  case "$_st" in
    selfstale)
      printf 'panoply: SELF-STALE — this check is out of date, so its verdict is not trustworthy.\n' >&2
      printf 'panoply: %s\n' "$_why" >&2
      printf 'panoply: this is the FALSE GREEN the kit now forbids: an obsolete doctor validated a repo\n' >&2
      printf 'panoply: against a layout the kit no longer uses. Bring the copy forward deliberately:\n' >&2
      printf 'panoply:   sh scripts/panoply.sh migrate     # then review the diff and commit\n' >&2
      if [ "${PANOPLY_ALLOW_UNVERIFIED:-0}" = "1" ]; then
        printf 'panoply: PANOPLY_ALLOW_UNVERIFIED=1 set — continuing with the repo verdict anyway\n' >&2
      fi
      exit 15 ;;
    current)
      [ "$_quiet" = 1 ] || printf 'panoply: OK — kit %s applied and current\n' "$_ver"
      exit 0 ;;
    absent)
      printf 'panoply: NOT APPLIED — %s (kit %s available)\n' "$_why" "$_ver" >&2
      printf 'panoply: adopt it:  sh scripts/panoply.sh apply   then complete the agent checklist in the kit README\n' >&2
      exit 10 ;;
    partial)
      printf 'panoply: HALF-APPLIED — %s\n' "$_why" >&2
      printf 'panoply: a half-applied kit fails its own doc gate and looks like a doc bug. Finish it:  sh scripts/panoply.sh apply\n' >&2
      exit 11 ;;
    stale)
      printf 'panoply: STALE — %s\n' "$_why" >&2
      printf 'panoply: read the kit CHANGELOG for what changed, then re-adopt/refresh.\n' >&2
      exit 12 ;;
    placeholders)
      printf 'panoply: UNADAPTED — %s\n' "$_why" >&2
      printf 'panoply: the kit was copied but never adapted; fill or delete every {{TOKEN}}.\n' >&2
      exit 13 ;;
    drifted)
      printf 'panoply: MIRRORS DRIFTED — %s\n' "$_why" >&2
      exit 14 ;;
    *)
      printf 'panoply: unknown state %s\n' "$_st" >&2; exit 1 ;;
  esac
}

# apply: the DETERMINISTIC half only. Everything that requires judgement (filling {{TOKEN}}s,
# pruning MODULE: blocks, merging a pre-existing AGENTS.md) is emitted as a checklist —
# a script must never guess a command table or a layer map, and the kit's own applier forbids it.
cmd_apply() {
  _yes=0
  for a in "$@"; do [ "$a" = "--yes" ] && _yes=1; done

  _src="$(cd "$(dirname "$0")/.." && pwd)"
  printf '==> panoply apply (deterministic half) — kit %s\n' "$(_kit_version)"

  # Per-file dispositions. Every managed file this run considered gets exactly one of:
  #   ADDED   — installed because it was absent
  #   KEPT    — a LOCAL copy differs from the kit and was left alone (never a silent clobber)
  #   DRIFTED — the run could NOT bring this file to the kit's bytes (a KEPT file, or force skipped)
  #   (matching files print nothing: they are already the kit's, so there is no news)
  # `_drifted=1` iff ANY managed file remains different from the kit after the run. It is what stops
  # the stamp from certifying a state apply did not reach.
  _drifted=0

  # 1. Spine. Create only what is absent; never overwrite the repo's own docs.
  mkdir -p docs/agents .agents/rules scripts
  for _d in roadmap.md in-progress.md worklog.md; do
    if [ ! -f "docs/agents/$_d" ] && [ -f "$_src/docs/agents/$_d" ]; then
      cp "$_src/docs/agents/$_d" "docs/agents/$_d"; printf '    ADDED docs/agents/%s\n' "$_d"
    elif [ -f "docs/agents/$_d" ] && ! cmp -s "$_src/docs/agents/$_d" "docs/agents/$_d"; then
      printf '    KEPT  docs/agents/%s — yours differs from the kit template; review it\n' "$_d"
    fi
  done

  # 2. Rule modules. Never clobber an edited module — report the divergence instead.
  for _m in "$_src"/.agents/rules/*.md; do
    [ -f "$_m" ] || continue
    _b="$(basename "$_m")"
    if [ ! -f ".agents/rules/$_b" ]; then
      cp "$_m" ".agents/rules/$_b"; printf '    ADDED .agents/rules/%s\n' "$_b"
    elif ! cmp -s "$_m" ".agents/rules/$_b"; then
      # A locally-diverged module is the NORMAL state: every adopter fills {{TOKENS}} at adapt time,
      # so its module legitimately differs from the template. That is not "drift" of the managed set —
      # it is adaptation, and the kit's contract is that yours wins. So it is reported, not forced,
      # and it does NOT by itself mark the repo drifted (or every correctly-adopted repo would stamp
      # +drifted forever, an always-red failure). Rule-module divergence is review signal.
      printf '    KEPT  .agents/rules/%s — yours differs (adapted?); review the kit CHANGELOG\n' "$_b"
    fi
  done

  # 2b. The agent hub itself. Seed the TEMPLATE only when the repo has no hub of its own — its
  # tokens stay in place on purpose, which is what makes the next check report "unadapted" (13)
  # rather than "half-applied (missing AGENTS.md)" (11). Without this, apply can never reach a
  # state an agent can finish from: every adoption would stall until someone hand-wrote a hub
  # from scratch. A repo with its own AGENTS.md is left completely alone here; the agent merges the
  # kit's structure into it as checklist step 3.
  if [ ! -f AGENTS.md ] && [ -f "$_src/AGENTS.md" ]; then
    cp "$_src/AGENTS.md" AGENTS.md
    printf '    ADDED AGENTS.md (kit template — fill its {{TOKENS}})\n'
  fi

  # 3. Gates + mirror generator.
  # Same contract as the rule modules above: NEVER silently clobber. A locally edited script is real
  # work — a pilot repo's check-docs.sh carries a conflict-marker sweep the kit template lacks — and
  # overwriting it is an unreported capability regression. Install when absent; when it differs,
  # report the divergence and leave the repo's copy alone. `--force-scripts` is the explicit opt-in
  # for a deliberate refresh, so the destructive path is always a stated choice. Unlike a rule module,
  # a diverged SCRIPT is drift: it is kit machinery, and the kit's copy is the authority for it. So it
  # marks the repo drifted (unless force replaces it), and the stamp says so.
  #
  # THE LIST IS DERIVED, NOT HAND-KEPT. It used to be a literal list, and it drifted: three gates the
  # shipped CI template invokes (check-spec.sh, check-expert-review.sh, check-agent-readiness.sh) were
  # never installed, so a freshly-adopted repo's FIRST PR died on "No such file or directory" — the
  # applier deterministically produced the kit's own exit-11 half-applied state. A hand-kept list next
  # to a template that names its own dependencies will always drift; read the template instead, so
  # applier and CI cannot disagree. Any `scripts/X.sh` the template invokes, plus its canary when one
  # exists, plus the kit's own core.
  _force_scripts=0
  for a in "$@"; do [ "$a" = "--force-scripts" ] && _force_scripts=1; done
  _tmpl_tmp="$(mktemp)"
  # The kit's own core, one per line so each is a matchable filename.
  for _c in panoply.sh panoply.test.sh sync-agents.sh; do printf '%s\n' "$_c" >> "$_tmpl_tmp"; done
  if [ -f "$_src/scripts/templates/ci-verify.yml" ]; then
    # Every script the shipped workflow runs, deduped.
    _from_template="$(grep -oE 'scripts/[a-zA-Z0-9._-]+\.sh' "$_src/scripts/templates/ci-verify.yml" \
                      | sed 's|scripts/||' | sort -u)"
  else
    _from_template=""
  fi
  printf '%s\n' "$_from_template" >> "$_tmpl_tmp"
  # A canary is installed wherever the script it tests is installed — a gate whose canary never ships
  # is a gate nobody can prove still detects.
  for _g in $_from_template; do
    case "$_g" in *.test.sh) ;; *)
      [ -f "$_src/scripts/${_g%.sh}.test.sh" ] && printf '%s\n' "${_g%.sh}.test.sh" >> "$_tmpl_tmp" ;;
    esac
  done
  _all_installs="$(sort -u "$_tmpl_tmp")"
  rm -f "$_tmpl_tmp"
  for _s in $_all_installs; do
    [ -f "$_src/scripts/$_s" ] || continue
    if [ ! -f "scripts/$_s" ]; then
      cp "$_src/scripts/$_s" "scripts/$_s" && chmod +x "scripts/$_s"
      printf '    ADDED scripts/%s\n' "$_s"
    elif ! cmp -s "$_src/scripts/$_s" "scripts/$_s"; then
      if [ "$_force_scripts" = "1" ]; then
        # Recoverable overwrite: write the pre-overwrite bytes beside the file BEFORE replacing it,
        # and say where. The defect this fixes: --force-scripts was destructive with no backup — a
        # repo-local capability (a pilot repo's check-docs.sh conflict sweep) was gone with recovery only
        # through git. Collision-safe suffix so a second forced run never destroys the first backup.
        _bak="scripts/${_s}.panoply-bak"
        [ -e "$_bak" ] && _bak="scripts/${_s}.panoply-bak.$(date -u +%Y%m%dT%H%M%SZ)"
        cp "scripts/$_s" "$_bak"
        cp "$_src/scripts/$_s" "scripts/$_s" && chmod +x "scripts/$_s"
        printf '    FORCED scripts/%s (--force-scripts); previous copy saved to %s\n' "$_s" "$_bak"
      else
        printf '    DRIFTED scripts/%s — yours differs from the kit; re-run with --force-scripts to refresh (a backup is written)\n' "$_s"
        _drifted=1
      fi
    fi
  done

  # 4. Stamp LAST among mechanical steps, so a failed apply never leaves a current-looking stamp — and
  # with the drift verdict, so it never certifies a state this run did not reach. `_panoply_drifted`
  # is read by cmd_stamp.
  _panoply_drifted="$_drifted"
  export _panoply_drifted
  cmd_stamp

  # 5. The judgement half — an agent must do this, and the kit forbids guessing.
  cat <<'CHECKLIST'

==> remaining (agent work — the kit forbids scripting these):
    1. Fill every {{TOKEN}} from the project's OWN manifests/script table; delete any bullet you
       cannot fill with a verified value (an unfillable rule teaches the model to skim).
    2. Prune <!-- MODULE:x --> blocks that do not apply, and delete the rules files + @-imports
       they own. Never delete clean-architecture.md, workflow.md, or quality-bar.md.
    3. Merge — never overwrite — a pre-existing AGENTS.md (the repo's own rules win).
    4. Run:  sh scripts/sync-agents.sh      (mirrors must be generated AFTER pruning)
    5. Run:  sh scripts/check-docs.sh && sh scripts/check-plan-home.sh && sh scripts/panoply.sh check
    6. Wire the Algorithm gate into CI (verify.yml: `sh scripts/check-algorithm.sh --since <base>`)
       and, where the repo has one, its pre-commit hook (`--staged`). It requires the plan doc's
       "Deletion candidates" section on a structural change — see .agents/rules/algorithm.md.

  Every managed file this run touched printed its disposition: ADDED (installed), KEPT (yours kept),
  DRIFTED (differs and was NOT brought current), FORCED (replaced, with a backup named above). If any
  line said DRIFTED, this repo is NOT current with the kit and the stamp says so — review the kit
  CHANGELOG and re-run `apply --force-scripts` when you mean to discard the local versions.
CHECKLIST

  # A drift verdict is a non-zero outcome: apply did not bring the repo to the kit, and a reader must
  # not be able to mistake it for success. This is the "fail loudly rather than fail open" contract.
  if [ "$_drifted" = "1" ]; then
    printf 'panoply: apply finished with DRIFT — the repo is NOT current with the kit (see DRIFTED lines)\n' >&2
    return 12
  fi
  return 0
}

# ---------------------------------------------------------------- migrate ----
# cmd_migrate: translate an OLD-layout adopter onto the current layout, deliberately and reviewably.
#
# What this is NOT: an auto-pull. It never fetches from the network and never writes a rule body the
# adopter has not seen — doctrine is that a rule change is REVIEWED, not silently overwritten. What it
# IS: the smallest reproducible path from "this repo adopted the kit before the layout changed" to
# "this repo is on the current layout, ready for a normal apply". It reports the translation it will
# perform BEFORE performing it, seeds the new-layout tree from the current kit with the same
# no-clobber contract apply uses, and then hands off to apply for the deterministic half.
#
# The translation: pre-v2 kit generations kept the doc spine at `docs/claude/` and the rule modules at
# `.claude/rules/`. The current kit requires `docs/agents/` and `.agents/rules/`. migrate COPIES the
# old tree into the new location (never deletes the old — the adopter reviews and removes it, or keeps
# it as history) and seeds any current-layout file the repo lacks.
cmd_migrate() {
  _src="$(cd "$(dirname "$0")/.." && pwd)"
  printf '==> panoply migrate — move an OLD-layout adopter onto the current layout (kit %s)\n' \
    "$(_kit_version)"

  # Old-layout markers. A repo on the new layout has nothing to migrate; say so and stop.
  _old=0
  [ -d docs/claude ] && _old=1
  [ -d .claude/rules ] && _old=1
  _new_docs="$([ -d docs/agents ] && printf yes || printf no)"
  _new_rules="$([ -d .agents/rules ] && printf yes || printf no)"

  if [ "$_old" = "0" ] && [ "$_new_docs" = "yes" ] && [ "$_new_rules" = "yes" ]; then
    printf '    already on the current layout (docs/agents + .agents/rules) — nothing to migrate\n'
    printf '    run:  sh scripts/panoply.sh apply   to refresh the deterministic half\n'
    return 0
  fi

  printf '    translation report (nothing below has been changed yet):\n'
  [ "$_new_docs" = "yes" ] && printf '      docs/agents/        already present — left alone\n' \
                           || printf '      docs/claude/     -> docs/agents/       (copy old spine forward)\n'
  [ "$_new_rules" = "yes" ] && printf '      .agents/rules/      already present — left alone\n' \
                            || printf '      .claude/rules/   -> .agents/rules/     (copy old modules forward)\n'

  # Seed the spine: copy the old tree FORWARD first (so the adopter's own adapted docs win), then let
  # apply fill anything still absent from the current kit. Prefer the repo's docs/claude content over
  # the kit template — it is the adopter's adapted text.
  mkdir -p docs/agents .agents/rules scripts
  if [ -d docs/claude ] && [ "$_new_docs" = "no" ]; then
    for _f in docs/claude/*.md; do
      [ -f "$_f" ] || continue
      _b="$(basename "$_f")"
      if [ ! -f "docs/agents/$_b" ]; then
        cp "$_f" "docs/agents/$_b"; printf '      copied docs/claude/%s -> docs/agents/%s\n' "$_b" "$_b"
      fi
    done
  fi
  # Same for the rule modules: the adopter's ADAPTED modules (tokens filled) are the better source.
  if [ -d .claude/rules ] && [ "$_new_rules" = "no" ]; then
    for _f in .claude/rules/*.md; do
      [ -f "$_f" ] || continue
      _b="$(basename "$_f")"
      if [ ! -f ".agents/rules/$_b" ]; then
        cp "$_f" ".agents/rules/$_b"; printf '      copied .claude/rules/%s -> .agents/rules/%s\n' "$_b" "$_b"
      fi
    done
  fi
  printf '    the OLD tree (docs/claude, .claude/rules) is left in place for you to review and delete —\n'
  printf '    migrate never removes a file it did not create.\n\n'

  # Refresh the doctor itself BEFORE apply, not after: the stamp apply writes is a claim about the
  # repository's final state, and if the old doctor were still in place at stamp time the stamp would
  # (correctly, but confusingly) read `+drifted`. Refreshing first means the stamp and the checked
  # state agree, and the very next `check` runs the current doctor. The previous copy is backed up so
  # an adopter who had local work in their doctor can recover it.
  if [ -f "$_src/scripts/panoply.sh" ] && ! cmp -s "$_src/scripts/panoply.sh" scripts/panoply.sh; then
    _dbak="scripts/panoply.sh.panoply-bak"
    [ -e "$_dbak" ] && _dbak="scripts/panoply.sh.panoply-bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cp scripts/panoply.sh "$_dbak"
    cp "$_src/scripts/panoply.sh" scripts/panoply.sh && chmod +x scripts/panoply.sh
    printf '    refreshed the doctor itself (previous copy saved to %s)\n\n' "$_dbak"
  fi

  # Hand off to apply for the deterministic half (it seeds whatever the copy-forward did not).
  cmd_apply "$@"
  _apply_rc=$?

  printf '\n==> migrate done — review the diff, then run:  sh scripts/panoply.sh check\n'
  printf '    finish the judgement half with .agents/commands/adapt-agents-setup.md before committing.\n'
  return "$_apply_rc"
}

# ---------------------------------------------------------------- dispatch ----
_cmd="${1:-check}"
shift 2>/dev/null || true
case "$_cmd" in
  check|status) cmd_check "$@" ;;
  apply)        cmd_apply "$@" ;;
  migrate)      cmd_migrate "$@" ;;
  stamp)        cmd_stamp "$@" ;;
  version|-v|--version) cmd_version ;;
  -h|--help|help|"")
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) printf 'panoply: unknown command %s (try: check | apply | migrate | stamp | version)\n' "$_cmd" >&2; exit 2 ;;
esac
