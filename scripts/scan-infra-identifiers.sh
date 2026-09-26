#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# scan-infra-identifiers.sh — BLOCKING guard against committing infrastructure
# identifiers to a public repository.
#
#   pnpm scan:infra                                    # scan the tracked tree
#   bash scripts/scan-infra-identifiers.sh --staged    # scan staged files only
#   bash scripts/scan-infra-identifiers.sh --self-test # canary: prove detection
#
# WHY A CUSTOM SCANNER (not gitleaks/trufflehog)
# ----------------------------------------------
# gitleaks and trufflehog detect SECRETS: API keys, tokens, private keys. This
# repo's exposure was a different class — a real production hostname baked into
# a Dockerfile ARG and into code defaults, the deploy box's filesystem layout in
# runbooks, internal container DNS names, and routable IPs. None of those are
# credentials, so neither stock tool flags them. CI runs gitleaks too (see
# .github/workflows/verify.yml) for the secret class; this script covers the
# infrastructure-identifier class.
#
# Deterministic by design: a fixed rule table, no scoring, no entropy
# heuristics, exit 1 on any non-allowlisted hit. A probabilistic scanner
# produced a false green on this exact repository before, so this one fails
# closed and is checkable by canary — `--self-test` seeds one hit per rule,
# asserts all six fire, deletes the file, then re-scans the real tree. Run it
# after ANY edit to this script.
#
# RULES
#   R1 prod domains     myfonto.com / getfonto.com / fonto.app
#   R2 host paths       /data/appdata, /data/_secrets, /data/backups,
#                       /data/fonto-media, /mnt/user/, /opt/app/
#   R3 ssh as root      `ssh root@…`
#   R4 routable IPv4    any IPv4 literal that is not loopback / any / broadcast /
#                       link-local / RFC1918 / RFC5737 documentation
#   R5 internal DNS     container service names used as hosts (valkey,
#                       plexo-vision, otel-collector, minio, …) outside the
#                       compose/ops/example files that legitimately define them
#   R6 personal email   any email that is not @example.* or the GitHub bot
#   R7 internal host    the deploy box naming itself (hostname gate, "the NAS")
#   R8 internal db      `pushd` — the shared production database name
#
# ADDING A RULE: append to RULES[] as "id<TAB>regex<TAB>why", then run
# --self-test with a canary line for it. A hit fails CI unless the exact path is
# allowlisted below WITH a written justification.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STAGED_ONLY=0
SELF_TEST=0
for arg in "$@"; do
  case "$arg" in
    --staged) STAGED_ONLY=1 ;;
    --self-test) SELF_TEST=1 ;;
    -h|--help) sed -n '4,48p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "scan-infra: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

# ── Rule table ──────────────────────────────────────────────────────────────
# Extended regexes (grep -E), matched line-by-line. R6 uses grep -P for its
# negative lookahead; see scan_one().
RULES=(
  'R1-prod-domain	(myfonto|getfonto)\.com|fonto\.app	Production hostname. Use <YOUR_APP_ORIGIN> or NEXT_PUBLIC_APP_URL supplied by the deployer — never a baked default.'
  'R2-host-path	/data/(appdata|_secrets|backups|fonto-media)|/mnt/user/|/opt/app/	Deploy-box filesystem layout. Use <host-path>, or a path relative to the repo.'
  'R3-ssh-root	ssh[[:space:]]+(-[^[:space:]]+[[:space:]]+)*root@	Remote-root access pattern. Use `ssh <server>` with a placeholder.'
  'R5-internal-dns	(https?|redis|rediss|amqp)://[a-z0-9._-]*(valkey|redis|plexo-vision|plexo-core|otel-collector|fonto-worker|fonto-db|minio|caddy|authentik|inngest)(:|[0-9])	Internal container DNS name. Legitimate inside compose/example files; elsewhere use localhost or <your-host>.'
  'R7-internal-hostname	hostname[^a-zA-Z]{0,4}[!=]=?\s*\"?NAS\b|expected NAS\b|deploy box|the NAS\b	Internal host identity (the deploy box names itself in a safety gate). Parameterize it, e.g. EXPECT_HOSTNAME.'
  'R8-internal-dbname	(postgres(ql)?|rediss?|amqp)://[^[:space:]]*/pushd\b|\bpushd\.(auth|public|fonto)\b|(-d|--dbname)[[:space:]]*=?[[:space:]]*[`"]?pushd\b|\b(live|database|db|schema|dump|restore)[[:space:]]+[`"]?pushd\b	Internal shared production DATABASE name. The bare word `pushd` is the public CI product name (.pushd.yaml, the `pushd/build` commit status) and must NOT be flagged - only its use as a database/schema identifier. Use a placeholder (<your-db>).'
  # The (?<![:$]) lookbehind skips URL userinfo (`x-access-token:$TOKEN@github.com`)
  # and shell interpolation — neither is an email address.
  'R6-personal-email	(?<![:$/])[a-zA-Z0-9._%+-]+@(?!example\.(com|org|net)|users\.noreply\.github\.com|github\.com)[a-zA-Z0-9.-]+\.(com|net|org|io|dev|app)	Personal or company email address. Use you@example.com in docs.'
)

# ── Allowlist: path prefix → why it is intentionally exempt ─────────────────
# Keep this SHORT and justified. A bare path entry exempts every rule in that
# subtree; a "<path><TAB><rule>" entry exempts one rule only — prefer that form
# so an unrelated leak added to the same file still fails the scan.
ALLOWLIST_PATHS=(
  # This scanner's own rule table contains the literals it hunts for.
  'scripts/scan-infra-identifiers.sh'
  # Self-hosting docs must name the placeholders the deployer substitutes, and
  # explain what was scrubbed and why.
  'docs/self-hosting.md'
  # ADRs record the decision + rationale, quoting the removed values.
  'docs/adr/'
  # The env template documents every variable including its safe placeholder.
  '.env.example'
  # Applied migrations are IMMUTABLE (AGENTS.md: "Never edit or delete a
  # migration that has been merged or applied anywhere but your own machine").
  # scripts/db-apply.sh identifies each migration by the SHA-256 of its file
  # contents, which is what `--adopt` writes into an existing production
  # database's bookkeeping. Reword a comment here and that hash changes, so the
  # database that actually ran the migration no longer matches the record of
  # what it ran — a fresh install and production then disagree about history.
  # Both hits below are SQL COMMENTS recording why Fonto kept its own schema
  # instead of the shared one; neither is executable, and neither can be
  # removed without violating the immutability rule.
  'drizzle/migrations/0055_passkey.sql	R8-internal-dbname'
  'drizzle/migrations/0056_one_time_links.sql	R8-internal-dbname'
)

# Files that legitimately describe a container topology with service DNS names.
ALLOW_R5_PATHS=(
  'docker-compose.yml'
  'docker-compose.override.example.yml'
  'ops/'
  '.env.example'
  'docs/self-hosting.md'
  'scripts/scan-infra-identifiers.sh'
)

# An entry is either a bare path prefix (exempts EVERY rule in that subtree) or
# a "<path prefix><TAB><rule-id>" pair (exempts that one rule only). Prefer the
# pair form: a whole-path exemption also silences every rule that has not fired
# in that file yet, so a leak added later passes unnoticed. The prefix match is
# against the part before the TAB.
is_allowlisted() {
  local file="$1" rule="$2" entry prefix want
  for entry in "${ALLOWLIST_PATHS[@]}"; do
    case "$entry" in
      *$'\t'*)
        prefix="${entry%%$'\t'*}"; want="${entry#*$'\t'}"
        [ "$want" = "$rule" ] || continue
        ;;
      *) prefix="$entry" ;;
    esac
    case "$file" in "$prefix"|"$prefix"*) return 0 ;; esac
  done
  if [ "$rule" = "R5-internal-dns" ]; then
    for entry in "${ALLOW_R5_PATHS[@]}"; do
      prefix="${entry%%$'\t'*}"
      case "$file" in "$prefix"|"$prefix"*) return 0 ;; esac
    done
  fi
  return 1
}

# ── File selection ──────────────────────────────────────────────────────────
list_files() {
  if [ "$STAGED_ONLY" = "1" ]; then
    git diff --cached --name-only --diff-filter=ACMR | while IFS= read -r f; do
      [ -f "$f" ] && echo "$f"
    done
  else
    git ls-files | while IFS= read -r f; do
      [ -f "$f" ] && echo "$f"
    done
  fi
}

# Only text-ish files can carry an identifier. Skip binaries and lockfiles.
# CHANGELOG-style history is deliberately NEVER rewritten (repo rule), so it is
# excluded rather than scrubbed.
is_scannable() {
  case "$1" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.mp4|*.mov|*.pdf|*.zip|*.gz|*.bz2|*.xz|*.jar|*.woff|*.woff2|*.ttf|*.eot|*.sqlite|*.db|*.jks|*.keystore|*.age|*.pgdump) return 1 ;;
    pnpm-lock.yaml|*/pnpm-lock.yaml|*/package-lock.json) return 1 ;;
    CHANGELOG.md|*/CHANGELOG.md|CHANGELOG|docs/CHANGELOG.md) return 1 ;;
    *) return 0 ;;
  esac
}

# ── IPv4 evaluation (needs arithmetic, so not a pure regex rule) ────────────
ip_ok() {
  local ip="$1" o2
  case "$ip" in
    127.*|0.0.0.0|255.255.255.255) return 0 ;;       # loopback / any / broadcast
    192.0.2.*|198.51.100.*|203.0.113.*) return 0 ;;  # RFC5737 documentation
    10.*|192.168.*) return 0 ;;                      # RFC1918 private
    172.*)                                           # RFC1918 172.16.0.0/12
      o2="${ip#172.}"; o2="${o2%%.*}"
      if [ "$o2" -ge 16 ] 2>/dev/null && [ "$o2" -le 31 ] 2>/dev/null; then return 0; fi
      ;;
    169.254.*) return 0 ;;                           # link-local
  esac
  return 1
}

# True iff a rule's regex uses PCRE-only constructs. `(?!...)`, `(?<!...)`,
# `(?=...)` are lookahead/lookbehind; `\\b` works in ERE but `(?...)` does not.
needs_pcre() {
  case "$1" in
    *'(?!'*|*'(?<'*|*'(?='*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Per-file scan (appends TSV rows to $VIOLATIONS) ─────────────────────────
scan_one() {
  local file="$1" entry rule rest re why lineno ip out o
  is_scannable "$file" || return 0

  for entry in "${RULES[@]}"; do
    rule="${entry%%$'\t'*}"; rest="${entry#*$'\t'}"; re="${rest%%$'\t'*}"; why="${rest#*$'\t'}"
    is_allowlisted "$file" "$rule" && continue
    # Rules whose regex uses PCRE-only syntax (lookahead/lookbehind) MUST run
    # under grep -P. Running one under grep -E is an invalid-ERE error — and an
    # error here means the rule silently matched nothing. That is the exact
    # false-green this scanner exists to prevent (R8 was dead this way), so grep
    # exit 2 is a hard failure, never swallowed. grep: 0=match, 1=no match, 2=err.
    # errexit MUST be off for these greps: `out="$(grep ...)"` takes the exit
    # status of the substitution, and grep returns 1 for "no match" — the common
    # case. Under `set -e` that 1 kills the whole scan mid-tree, silently, with
    # no report. We still need the real status to tell "no match" (1) apart from
    # "invalid regex / unreadable file" (2+), so capture it explicitly.
    set +e
    if needs_pcre "$re"; then
      out="$(grep -nP --color=never "$re" "$file" 2>&1)"; rc=$?
    else
      out="$(grep -nE --color=never "$re" "$file" 2>&1)"; rc=$?
    fi
    set -e
    if [ "$rc" -ge 2 ]; then
      echo "scan-infra: INTERNAL ERROR — rule $rule failed to execute against $file:" >&2
      echo "$out" | head -3 | sed 's/^/    /' >&2
      echo "  A rule that cannot run reports zero hits. Aborting rather than" >&2
      echo "  returning a false green." >&2
      exit 3
    fi
    [ -z "$out" ] && continue
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      lineno="${hit%%:*}"
      printf '%s\t%s:%s\t%s\n' "$rule" "$file" "$lineno" "$why" >> "$VIOLATIONS"
    done <<< "$out"
  done

  is_allowlisted "$file" "R4-routable-ip" && return 0
  # Vendored vector art (public/*.svg) carries 4-part dotted numbers in path
  # data ("3.5.7.9" inside a `d=` attribute) that are geometry, not addresses.
  case "$file" in *.svg) return 0 ;; esac
  while IFS=: read -r lineno ip; do
    [ -z "${ip:-}" ] && continue
    # Exactly four octets: longer dotted strings and 3-part semver are not IPv4.
    echo "$ip" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || continue
    for o in ${ip//./ }; do [ "$o" -le 255 ] 2>/dev/null || continue 2; done
    ip_ok "$ip" && continue
    printf '%s\t%s:%s\t%s\n' "R4-routable-ip" "$file" "$lineno" \
      "Routable IPv4 literal '$ip'. Use a hostname, <your-host>, or an RFC5737 documentation address." >> "$VIOLATIONS"
  done < <(grep -nEo '[0-9]{1,3}(\.[0-9]{1,3}){3,}' "$file" 2>/dev/null || true)
  return 0
}

run_scan() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] && scan_one "$f"
  done < <(list_files)
  return 0
}

report() {
  local count
  if [ -s "$VIOLATIONS" ]; then
    count="$(sort -u "$VIOLATIONS" | wc -l | tr -d ' ')"
    echo "scan-infra: FAILED — $count infrastructure identifier(s) in tracked files." >&2
    echo >&2
    sort -u "$VIOLATIONS" | while IFS=$'\t' read -r rule loc why; do
      echo "  [$rule] $loc" >&2
      echo "      why: $why" >&2
    done
    echo >&2
    echo "  Fix the value, or — only with a written justification — add the path to" >&2
    echo "  ALLOWLIST_PATHS in scripts/scan-infra-identifiers.sh." >&2
    echo "  After editing this scanner, prove it still detects:" >&2
    echo "      bash scripts/scan-infra-identifiers.sh --self-test" >&2
    exit 1
  fi
  echo "scan-infra: OK — no infrastructure identifiers in tracked files."
}

# ── Self-test (canary) ──────────────────────────────────────────────────────
# Proves the scanner DETECTS violations instead of returning a false green. One
# canary line per rule; asserts all six fire, deletes the file, asserts the tree
# is clean, then scans the real tree.
self_test() {
  local canary="scripts/.infra-scan-canary.md" found after_clean
  cat > "$canary" <<'CANARY'
<!-- Temporary canary for scripts/scan-infra-identifiers.sh --self-test. -->
R1 domain: https://myfonto.com and https://app.getfonto.com
R2 path:   /data/appdata/canary-test and /mnt/user/appdata
R3 access: ssh root@canary-host
R4 ip:     8.8.8.8 is routable; 203.0.113.5 is documentation and must NOT hit
R5 dns:    redis://valkey:6379
R6 email:  canary.personal@somerealdomain.com
R7 host:   if [ "$(hostname)" != "NAS" ]; then echo "expected NAS"; fi
R8 db:     pg_dump -U postgres -d pushd | gzip; psql postgresql://u@host:5432/pushd; `pushd`.auth is the live schema
R8 ctrl:   the CI product pushd (.pushd.yaml, pushd/build status) must NOT be a finding
CANARY

  # Allowlist well-formedness: a malformed entry is INERT — it still reads as an
  # exemption in the source, so reviewers assume the path is covered, while the
  # rule keeps firing (or the stray quote swallows the next entry). Validate the
  # shape rather than trusting it: path, or path<TAB>rule-id.
  local entry prefix want bad=0
  for entry in "${ALLOWLIST_PATHS[@]}"; do
    case "$entry" in
      *$'\t'*)
        prefix="${entry%%$'\t'*}"; want="${entry#*$'\t'}"
        case "$want" in
          R[0-9]-*) : ;;
          *) echo "scan-infra: SELF-TEST FAILED — allowlist entry for '$prefix' has" >&2
             echo "            an unrecognised rule id '$want'." >&2; bad=1 ;;
        esac
        ;;
    esac
    case "$entry" in
      "'"*|*"'"*)
        echo "scan-infra: SELF-TEST FAILED — allowlist entry contains a stray quote:" >&2
        echo "            [$entry]" >&2; bad=1 ;;
    esac
    case "$entry" in
      *' '*) echo "scan-infra: SELF-TEST FAILED — allowlist entry contains a space" >&2
             echo "            (quote the whole 'path<TAB>rule' pair): [$entry]" >&2; bad=1 ;;
    esac
  done
  [ "$bad" = "1" ] && exit 1

  # Negative-path control: a CLEAN file must scan to zero findings WITHOUT
  # aborting the process. Every rule below matches nothing here, which exercises
  # grep's exit-1 branch — the path a positive-only canary never reaches. A scan
  # that dies on "no match" reports nothing at all and still exits non-zero, so
  # it can look like a passing gate while having checked only part of the tree.
  local clean="scripts/.infra-scan-clean.md"
  {
    echo "<!-- Temporary clean control for --self-test. -->"
    echo "A plain sentence about the deploy host and its database."
    echo "REDIS_URL=redis://localhost:6379 and OTEL endpoint on port 4318."
    echo "Contact you@example.com; see <YOUR_APP_ORIGIN> and <host-path>/ops/.env."
  } > "$clean"
  : > "$VIOLATIONS"
  scan_one "$clean"
  local clean_found
  clean_found="$(sort -u "$VIOLATIONS" | wc -l | tr -d ' ')"
  rm -f "$clean"
  if [ "$clean_found" != "0" ]; then
    echo "scan-infra: SELF-TEST FAILED — the clean control produced $clean_found finding(s)." >&2
    sort -u "$VIOLATIONS" | sed 's/^/    /' >&2
    exit 1
  fi
  echo "scan-infra: self-test clean control produced 0 findings (no-match path OK)."

  # Scan the canary directly (untracked, so list_files would skip it).
  : > "$VIOLATIONS"
  scan_one "$canary"
  found="$(sort -u "$VIOLATIONS" | wc -l | tr -d ' ')"
  echo "scan-infra: self-test canary produced $found finding(s):"
  sort -u "$VIOLATIONS" | while IFS=$'\t' read -r rule loc why; do echo "    [$rule] $loc"; done

  rm -f "$canary"
  after_clean="$(git status --porcelain -- "$canary" | wc -l | tr -d ' ')"

  if [ "$found" -lt 8 ]; then
    echo "scan-infra: SELF-TEST FAILED — expected >= 8 findings (one per rule R1-R8), got $found." >&2
    echo "            The scanner is NOT detecting violations; do not trust a clean run." >&2
    exit 1
  fi
  if [ "$after_clean" != "0" ]; then
    echo "scan-infra: SELF-TEST FAILED — canary file was not cleaned up." >&2
    exit 1
  fi
  # R4 negative control: the documentation-range IP must NOT have been reported.
  if sort -u "$VIOLATIONS" | grep -q "203.0.113.5"; then
    echo "scan-infra: SELF-TEST FAILED — RFC5737 documentation IP was flagged as routable." >&2
    exit 1
  fi
  # R8 negative control: the canary names the CI product `pushd` on a line that
  # is NOT a database identifier. Flagging it would bury the rule in false
  # positives across .pushd.yaml, which is how a real DB-name leak gets
  # allowlisted away. The finding count must come from the DB-context line only.
  r8_lines="$(sort -u "$VIOLATIONS" | awk -F'\t' '$1=="R8-internal-dbname"{print $2}')"
  if echo "$r8_lines" | grep -q ":10$"; then
    echo "scan-infra: SELF-TEST FAILED — the CI product name \`pushd\` was flagged as" >&2
    echo "            an internal DB name. R8 is over-broad; narrow it to DB contexts." >&2
    exit 1
  fi
  if [ -z "$r8_lines" ]; then
    echo "scan-infra: SELF-TEST FAILED — R8 found nothing; the rule is dead again." >&2
    exit 1
  fi
  echo "scan-infra: SELF-TEST PASSED — canary detected ($found findings across R1-R8), documentation-range IP correctly ignored, canary file removed, worktree clean."

  # Second half: scan the real tree and report normally.
  : > "$VIOLATIONS"
  run_scan
  report
}

VIOLATIONS="$(mktemp)"
trap 'rm -f "$VIOLATIONS" scripts/.infra-scan-canary.md scripts/.infra-scan-clean.md' EXIT

if [ "$SELF_TEST" = "1" ]; then
  self_test
  exit 0
fi

run_scan
report
