#!/usr/bin/env sh
# check-agent-readiness.sh — the mechanical floor for dual-mode agent readiness.
#
# Enforces what .agents/rules/agent-readiness.md can check WITHOUT judgement. The parts that need
# judgement (does a tool description read well? can a real harness complete a goal?) stay in the
# review checklist and the agent-perspective smoke test — this script does not pretend to cover them.
#
#   sh scripts/check-agent-readiness.sh          # check the working tree
#   sh scripts/check-agent-readiness.sh --since REF   # same checks, plus "did this PR touch an agent surface
#                                                     # without touching its counterpart" drift check
#
# Checks, in order:
#   1. agent card      — a well-known agent card exists, is valid JSON, declares the required fields
#   2. card routing    — the card is actually SERVED at /.well-known/ (not just sitting in public/)
#   3. idempotency     — mutation routes are covered by an idempotency mechanism
#   4. schema gen      — MCP tool schemas are generated from the API schemas, not hand-written
#   5. llm config      — no vendor LLM endpoint or model id hardcoded outside the LLM adapter
#   6. agent identity  — a non-human principal (scoped key / service token) exists, not only session auth
#   7. surface drift   — (--since) an agent-surface change shipped without its doc/counterpart update
#
# Knobs (env). Every one has a working default; set only what your repo deviates from.
#   AGENT_READINESS=off            skip entirely (module was pruned but the script was left behind)
#   AGENT_READINESS_ENFORCE=warn   print FAILs but exit 0 — for a repo mid-adoption. Never leave it on.
#   AGENT_CARD_PATH                default: auto-detect (public/.well-known/agent-card.json,
#                                   app/.well-known/agent-card.json/route.*, etc.)
#   AGENT_CARD_REQUIRED_FIELDS     default: name url version capabilities
#   AGENT_LLM_ADAPTER_GLOB         space-separated globs allowed to name a vendor; default: auto-detect
#   AGENT_IDEMPOTENCY_TOKENS       default: "Idempotency-Key idempotencyKey idempotency_key"
#
# POSIX sh. Optional helpers (jq / python3 / node) are used for JSON validation when present; without
# any of them the JSON checks SKIP loudly rather than silently passing.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "${AGENT_READINESS:-on}" = "off" ] && { echo "check-agent-readiness: disabled (AGENT_READINESS=off)"; exit 0; }

ENFORCE="${AGENT_READINESS_ENFORCE:-fail}"
FAILS=0
SKIPS=0

pass() { printf 'ok    %s\n' "$1"; }
skip() { printf 'SKIP  %s\n' "$1"; SKIPS=$((SKIPS + 1)); }
fail() {
  printf 'FAIL  %s\n' "$1" >&2
  [ -n "${2:-}" ] && printf '        %s\n' "$2" >&2
  FAILS=$((FAILS + 1))
}

# --- helpers ---------------------------------------------------------------

# json_get <file> — validate JSON and echo a compact field listing. Tries jq, python3, node.
JSON_TOOL=""
for t in jq python3 node; do
  command -v "$t" >/dev/null 2>&1 && { JSON_TOOL="$t"; break; }
done

json_fields() {
  f="$1"
  case "$JSON_TOOL" in
    jq)      jq -r 'paths(scalars) | join(".")' "$f" 2>/dev/null | cut -d. -f1 | sort -u ;;
    python3) python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
ks=list(d) if isinstance(d,dict) else []
print("\n".join(ks))' "$f" 2>/dev/null ;;
    node)    node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
console.log(Object.keys(d).join("\n"));' "$f" 2>/dev/null ;;
    *)       return 2 ;;
  esac
}

# grep_tree <regex> [path...] — case-sensitive content search, excluding noise dirs.
#
# The gate's OWN sources are excluded: check-agent-readiness.sh and the rules module name every
# pattern they look for as string literals, so without this the script passes itself and reports
# MCP + scoped-auth as present in a repo that has neither. Any file whose job is to name these
# patterns (this script, other gates) must stay out of the corpus.
#
# Generated tool mirrors are excluded too, but NOT by naming tools here: they are gitignored, and
# rg honours .gitignore natively. For the grep fallback (no rg on the box) we ask git which paths
# are ignored and drop them from the results — so the exclusion follows the repo's own .gitignore
# rather than a hardcoded vendor list that silently rots when a new mirror is added.
SELF_EXCLUDE='check-agent-readiness\.sh$|/scripts/check-|agent-readiness\.md$|/\.agents/rules/|^AGENTS\.md$'

_ignored_paths() {  # repo-relative paths git considers ignored; empty when git is unavailable
  git ls-files --others --ignored --exclude-standard 2>/dev/null || true
}

grep_tree() {
  pattern="$1"; shift
  local_hits=""
  if command -v rg >/dev/null 2>&1; then
    # rg already skips .gitignore'd paths, so generated mirrors never enter the corpus here
    local_hits="$(rg -l --no-messages -g '!node_modules' -g '!dist' -g '!.next' -g '!build' -g '!vendor' \
       -g '!.git' -g '!*.lock' -g '!pnpm-lock.yaml' -e "$pattern" "${@:-.}" 2>/dev/null \
       | grep -Ev "$SELF_EXCLUDE" || true)"
  else
    local_hits="$(grep -rlE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
         --exclude-dir=.next --exclude-dir=build --exclude-dir=vendor \
         -e "$pattern" "${@:-.}" 2>/dev/null \
         | grep -Ev "$SELF_EXCLUDE" || true)"
    # grep has no .gitignore support: subtract the ignored set by hand
    _ign="$(_ignored_paths)"
    if [ -n "$_ign" ]; then
      local_hits="$(printf '%s\n' "$local_hits" | sed 's|^\./||' \
        | grep -vxF "$_ign" || true)"
    fi
  fi
  printf '%s\n' "$local_hits" | grep -v '^$' || true
}

# --- 1. agent card ---------------------------------------------------------

CARD="${AGENT_CARD_PATH:-}"
if [ -z "$CARD" ]; then
  CARD="$(find . -path ./node_modules -prune -o -type f \
            \( -name 'agent-card.json' -o -name 'agent.json' \) -print 2>/dev/null \
          | grep -E '(^|/)\.well-known/' | head -1 || true)"
fi

if [ -z "$CARD" ] || [ ! -f "$CARD" ]; then
  fail "agent card missing" \
       "no .well-known/agent-card.json found. Serve one — it is how an agent discovers this app (agent-readiness.md → The A2A surface)."
else
  if [ -z "$JSON_TOOL" ]; then
    skip "agent card JSON validation — no jq/python3/node available; found $CARD but could not parse it"
  else
    if fields="$(json_fields "$CARD")"; then
      REQUIRED="${AGENT_CARD_REQUIRED_FIELDS:-name url version capabilities}"
      missing=""
      for f in $REQUIRED; do
        printf '%s\n' "$fields" | grep -qx "$f" || missing="$missing $f"
      done
      if [ -n "$missing" ]; then
        fail "agent card at $CARD is missing required field(s):$missing" \
             "an agent reading this card cannot decide whether to delegate here. Required: $REQUIRED."
      else
        pass "agent card present and complete — $CARD"
      fi
    else
      fail "agent card at $CARD is not valid JSON" "a card that does not parse is worse than no card: discovery fails silently."
    fi
  fi
fi

# --- 2. card is actually served -------------------------------------------
# A card in public/ is served statically by most frameworks; a route handler under
# app/.well-known or pages/api/.well-known is served dynamically. Anything else is a file
# nobody can fetch.

if [ -n "$CARD" ] && [ -f "$CARD" ]; then
  case "$CARD" in
    */public/.well-known/*|*/static/.well-known/*|*/www/.well-known/*)
      pass "agent card is in a statically-served directory — $CARD" ;;
    *route.*|*/api/*|*handler*)
      pass "agent card has a route handler — $CARD" ;;
    *)
      fail "agent card at $CARD is not in a served path" \
           "move it under public/.well-known/ or add a route that serves it unauthenticated — a card behind no route, or behind auth, cannot be discovered." ;;
  esac
fi

# --- 3. idempotency on mutations ------------------------------------------
# Agents retry. A mutation without an idempotency key duplicates on retry.
# Static detection is best-effort: find mutation sites, then require an idempotency
# mechanism to exist AND to be reachable from them (global middleware, or per-route use).

IDEM_TOKENS="${AGENT_IDEMPOTENCY_TOKENS:-Idempotency-Key idempotencyKey idempotency_key}"

MUTATION_HITS="$(
  {
    grep_tree 'export +(async +)?function +(POST|PUT|PATCH|DELETE)'
    grep_tree '\b(router|app|fastify|server)\.(post|put|patch|delete)\('
    grep_tree '@(Post|Put|Patch|Delete)\('
  } | sort -u
)"

if [ -z "$MUTATION_HITS" ]; then
  skip "idempotency — no mutation routes detected (read-only service, or a stack this script does not recognise)"
else
  MUT_COUNT="$(printf '%s\n' "$MUTATION_HITS" | grep -c . || true)"
  IDEM_HITS="$(
    for t in $IDEM_TOKENS; do grep_tree "$t"; done | sort -u
  )"
  if [ -z "$IDEM_HITS" ]; then
    fail "no idempotency mechanism, but $MUT_COUNT file(s) define mutations" \
         "agents retry on timeout and on ambiguous errors — without an idempotency key a retry duplicates the write. See agent-readiness.md → The HTTP API is the foundation."
  else
    # A global middleware/helper counts as covering every route; otherwise require the
    # mutation files themselves to reference it.
    GLOBAL="$(printf '%s\n' "$IDEM_HITS" | grep -Ei 'middleware|interceptor|plugin|guard|_lib/|/lib/|/core/|/shared/' || true)"
    if [ -n "$GLOBAL" ]; then
      pass "idempotency mechanism present and global — $(printf '%s\n' "$GLOBAL" | head -1)"
    else
      COVERED=0
      for m in $MUTATION_HITS; do
        for t in $IDEM_TOKENS; do
          grep -qE "$t" "$m" 2>/dev/null && { COVERED=$((COVERED + 1)); break; }
        done
      done
      if [ "$COVERED" -eq 0 ]; then
        fail "idempotency mechanism exists but no mutation route uses it" \
             "$MUT_COUNT mutation file(s) found, 0 reference an idempotency key. Wire the helper in, or register it as global middleware."
      elif [ "$COVERED" -lt "$MUT_COUNT" ]; then
        printf '        uncovered mutation files:\n' >&2
        for m in $MUTATION_HITS; do
          hit=0
          for t in $IDEM_TOKENS; do grep -qE "$t" "$m" 2>/dev/null && hit=1; done
          [ "$hit" -eq 0 ] && printf '          %s\n' "$m" >&2
        done
        fail "$((MUT_COUNT - COVERED)) of $MUT_COUNT mutation files do not handle an idempotency key"
      else
        pass "idempotency covered on all $MUT_COUNT mutation files"
      fi
    fi
  fi
fi

# --- 4. MCP schemas generated, not hand-written ---------------------------

MCP_PRESENT="$(grep_tree '@modelcontextprotocol|modelcontextprotocol|McpServer|mcp_server|FastMCP' || true)"

if [ -z "$MCP_PRESENT" ]; then
  skip "MCP schema generation — no MCP server detected in this repo"
else
  GEN="$(grep_tree 'zod-to-json-schema|zodToJsonSchema|toJSONSchema|json_schema\(|JsonSchemaFromZod|generateToolSchemas|buildTools\(' || true)"
  HANDWRITTEN="$(printf '%s\n' "$MCP_PRESENT" | grep -Ei 'mcp' | head -20 || true)"
  if [ -n "$GEN" ]; then
    pass "MCP tool schemas are generated from validation schemas — $(printf '%s\n' "$GEN" | head -1)"
  else
    fail "MCP server found but no evidence its tool schemas are generated" \
         "hand-written MCP schemas are a second source of truth and drift silently. Generate them from the API's zod/pydantic/JSON-Schema definitions in the build. Files: $(printf '%s' "$HANDWRITTEN" | tr '\n' ' ')"
  fi
fi

# --- 5. LLM config: no vendor lock ----------------------------------------
# Naming a vendor is fine INSIDE the adapter (that is what an adapter is for) and fine in
# docs/config/tests. It is a defect anywhere inward of it.

VENDOR_RE='api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.deepseek\.com|api\.x\.ai|openai\.AzureOpenAI|new +OpenAI\(|Anthropic\(|genai\.Client\('

VENDOR_HITS="$(grep_tree "$VENDOR_RE" || true)"
# drop docs, config, tests, env examples, lockfiles, and the LLM adapter itself
VENDOR_HITS="$(printf '%s\n' "$VENDOR_HITS" | grep -Ev '\.md$|\.mdx$|/docs?/|test|spec|__tests__|\.env|\.example|\.ya?ml$|lock' | grep -v '^$' || true)"

if [ -n "${AGENT_LLM_ADAPTER_GLOB:-}" ]; then
  for g in $AGENT_LLM_ADAPTER_GLOB; do
    VENDOR_HITS="$(printf '%s\n' "$VENDOR_HITS" | grep -v "$g" || true)"
  done
else
  VENDOR_HITS="$(printf '%s\n' "$VENDOR_HITS" | grep -Evi 'adapter|gateway|/llm/|llm-|provider|client\.|infra' || true)"
fi

if [ -z "$VENDOR_HITS" ]; then
  pass "no vendor LLM endpoint/SDK hardcoded outside an adapter path"
else
  printf '        offending files:\n' >&2
  printf '%s\n' "$VENDOR_HITS" | head -10 | sed 's/^/          /' >&2
  fail "vendor LLM endpoint or SDK referenced outside the LLM adapter" \
       "breaks the gateway case and the vendor swap. Route through the internal LLM client, configure via LLM_BASE_URL/LLM_API_KEY/LLM_MODEL (agent-readiness.md → LLM configuration)."
fi

# --- 6. a non-human principal exists --------------------------------------
# Session/browser auth alone means an agent cannot authenticate at all.

AGENT_AUTH="$(grep_tree 'X-API-Key|x-api-key|apiKey|api_key|API_KEY|serviceToken|service_account|client_credentials|BearerToken|createApiKey|scopes' || true)"
if [ -z "$AGENT_AUTH" ]; then
  fail "no API-key / service-principal auth detected" \
       "an agent cannot drive a browser session. Issue scoped keys for non-human callers and enforce scopes in the use case (agent-readiness.md → Agent identity)."
else
  SCOPE="$(grep_tree '\bscopes?\b|least.?privilege|permission(s)?\b' || true)"
  if [ -z "$SCOPE" ]; then
    fail "API-key auth exists but no scope/permission model found with it" \
         "an unscoped agent key is a full-access credential held by a process that retries and can be prompt-injected. Scope it, and enforce per record in the use case."
  else
    pass "non-human principal with scopes detected"
  fi
fi

# --- 7. surface drift (--since) -------------------------------------------
# An agent surface changed without its counterpart is how the API and the MCP tools
# silently stop agreeing.

if [ "${1:-}" = "--since" ]; then
  ref="${2:?usage: check-agent-readiness.sh --since <ref>}"
  # Ref-guard, matching check-spec.sh / check-expert-review.sh / check-algorithm.sh: a --since base
  # that does not resolve must REFUSE loudly (exit 2), never fall through to "no changed files / OK".
  # This gate previously used a bare `rev-parse --verify`, the pre-fix shape; the same question must
  # get the same answer in every gate or the divergence is the bug.
  if ! git rev-parse -q --verify "${ref}^{commit}" >/dev/null 2>&1; then
    printf 'check-agent-readiness: --since ref %s does not resolve in this checkout (shallow clone or wrong ref).\n' "$ref" >&2
    printf '  Pass the PR base SHA, or set AGENT_READINESS_ENFORCE=warn for a deliberate skip.\n' >&2
    exit 2
  else
    CHANGED="$(git diff --name-only "$ref"..HEAD 2>/dev/null || true)"
    if [ -n "$CHANGED" ]; then
      API_CHANGED="$(printf '%s\n' "$CHANGED" | grep -Ei 'app/api/|routes?/|controller|handler|endpoint|schema' || true)"
      MCP_CHANGED="$(printf '%s\n' "$CHANGED" | grep -Ei 'mcp|tool' || true)"
      CARD_CHANGED="$(printf '%s\n' "$CHANGED" | grep -Ei 'well-known|agent-card' || true)"
      DOC_CHANGED="$(printf '%s\n' "$CHANGED" | grep -Ei '\.md$|docs/' || true)"
      if [ -n "$API_CHANGED" ] && [ -z "$MCP_CHANGED" ] && [ -n "$MCP_PRESENT" ]; then
        fail "this PR changed the API surface but not the MCP layer" \
             "if the MCP schemas are generated, re-run generation and commit the output; if a capability was added, expose it as a tool. API/MCP drift is silent."
      elif [ -n "$MCP_CHANGED$CARD_CHANGED" ] && [ -z "$DOC_CHANGED" ]; then
        fail "this PR changed an agent surface but no documentation" \
             "an agent card or MCP tool list is a published contract — record the change in the worklog/plan doc, in this same commit."
      else
        pass "no agent-surface drift detected in $ref..HEAD"
      fi
    else
      skip "surface drift — no changed files between $ref and HEAD"
    fi
  fi
fi

# --- verdict ---------------------------------------------------------------

printf '\ncheck-agent-readiness: %s check(s) failed, %s skipped\n' "$FAILS" "$SKIPS"

if [ "$FAILS" -gt 0 ]; then
  if [ "$ENFORCE" = "warn" ]; then
    printf 'check-agent-readiness: AGENT_READINESS_ENFORCE=warn — reporting, not blocking.\n' >&2
    printf 'check-agent-readiness: this is an adoption aid, not a state to leave on.\n' >&2
    exit 0
  fi
  printf 'check-agent-readiness: see .agents/rules/agent-readiness.md for the rule and the review checklist.\n' >&2
  printf 'check-agent-readiness: mid-adoption? set AGENT_READINESS_ENFORCE=warn TEMPORARILY and record the gap in docs/agents/in-progress.md.\n' >&2
  exit 1
fi

[ "$SKIPS" -gt 0 ] && printf 'check-agent-readiness: %s check(s) could not run — verify those by hand (the gate enforces presence, not correctness).\n' "$SKIPS"
echo "check-agent-readiness: OK"
exit 0
