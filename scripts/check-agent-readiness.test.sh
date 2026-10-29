#!/usr/bin/env sh
# check-agent-readiness.test.sh — canary test for scripts/check-agent-readiness.sh.
#
# A gate that has never been seen to FAIL is a claim, not a gate. This builds two throwaway repos in a
# temp dir — one seeded with every defect the gate is supposed to catch, one built correctly — and
# asserts the gate fails the first and passes the second. Run it in CI and after any edit to the gate:
# a gate edited without a canary run can silently stop detecting anything.
#
#   sh scripts/check-agent-readiness.test.sh          # run; non-zero exit means the gate is broken
#
# POSIX sh, no runtime deps beyond what the gate itself needs. Writes nothing outside $TMPDIR.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/check-agent-readiness.sh"
[ -f "$GATE" ] || { echo "FATAL: $GATE not found" >&2; exit 1; }

WORK="${TMPDIR:-/tmp}/agent-readiness-canary.$$"
BAD="$WORK/bad"
GOOD="$WORK/good"
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$BAD/scripts" "$GOOD/scripts"
cp "$GATE" "$BAD/scripts/"
cp "$GATE" "$GOOD/scripts/"

FAILED=0
note() { printf '%s\n' "$*"; }

# run_gate <dir> [gate args...] — run the gate inside a fixture repo. Sets GATE_OUT to its combined
# stdout+stderr and returns the gate's exit status, so a canary can assert on both without running
# the gate twice.
#
# Deliberately `;`-separated inside the command substitution, not `cd X && cmd || true`: the latter is
# the A-and-B-or-C shape SC2015 warns about (C can run when A succeeded), and shellcheck versions
# disagree on whether `|| true` is obviously intentional — 0.11 is quiet, older runners are not.
# This form is unambiguous on every version: the cd is guarded by its own exit.
GATE_OUT=""
GATE_STATUS=0
run_gate() {
  _dir="$1"; shift
  # `if` guards the assignment against `set -e` (a FAILing gate exits non-zero, which is the
  # expected case for the bad fixture) and records the real status without an A && B || C shape.
  if GATE_OUT="$( ( cd "$_dir" || exit 99
                    sh scripts/check-agent-readiness.sh "$@" ) 2>&1 )"; then
    GATE_STATUS=0
  else
    GATE_STATUS=$?
  fi
  return "$GATE_STATUS"
}

# --- BAD fixture: one instance of every defect the gate claims to catch ----

mkdir -p "$BAD/app/api/tasks"
cat > "$BAD/app/api/tasks/route.ts" <<'EOF'
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'https://api.openai.com/v1' });
export async function POST(req: Request) {
  return Response.json(await client.chat.completions.create({ model: 'gpt-4o' }));
}
export async function DELETE(req: Request) { return new Response(null, { status: 204 }); }
EOF
mkdir -p "$BAD/src/mcp"
cat > "$BAD/src/mcp/server.ts" <<'EOF'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server = new McpServer({ name: 'bad' });
server.tool('create_task', { title: { type: 'string' } }, async () => ({}));
EOF
mkdir -p "$BAD/src/auth"
cat > "$BAD/src/auth/apikey.ts" <<'EOF'
export function readApiKey(req: Request) { return req.headers.get('X-API-Key'); }
EOF

# --- GOOD fixture: the same shape, built per the rules ---------------------

mkdir -p "$GOOD/public/.well-known"
cat > "$GOOD/public/.well-known/agent-card.json" <<'EOF'
{"name":"Good App","url":"https://example.com/a2a","version":"1.0.0","capabilities":{"streaming":true},"skills":[{"id":"create_task","name":"Create task"}]}
EOF
mkdir -p "$GOOD/app/api/tasks"
cat > "$GOOD/app/api/tasks/route.ts" <<'EOF'
import { summarize } from '../../../src/adapters/llm/client';
import { withIdempotency } from '../../../src/lib/idempotency';
export const POST = withIdempotency(async (req: Request) => {
  const key = req.headers.get('Idempotency-Key');
  return Response.json({ ok: true, key, text: await summarize('x') });
});
EOF
mkdir -p "$GOOD/src/adapters/llm"
cat > "$GOOD/src/adapters/llm/client.ts" <<'EOF'
// The one place a vendor may be named. Configured solely by env.
import OpenAI from 'openai';
export const llm = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
});
export const summarize = (t: string) =>
  llm.chat.completions.create({
    model: process.env.LLM_MODEL!,
    messages: [{ role: 'user', content: t }],
  });
EOF
mkdir -p "$GOOD/src/lib"
echo 'export function withIdempotency(h: any) { return h; }' > "$GOOD/src/lib/idempotency.ts"
mkdir -p "$GOOD/src/mcp"
cat > "$GOOD/src/mcp/server.ts" <<'EOF'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CreateTaskSchema } from '../schemas/task';
const server = new McpServer({ name: 'good' });
server.tool('create_task', zodToJsonSchema(CreateTaskSchema), async () => ({}));
EOF
mkdir -p "$GOOD/src/auth"
cat > "$GOOD/src/auth/apikey.ts" <<'EOF'
export type Scope = 'read' | 'write:tasks';
export function readApiKey(req: Request) { return req.headers.get('X-API-Key'); }
export function requireScope(scopes: Scope[], need: Scope) { return scopes.includes(need); }
EOF
mkdir -p "$GOOD/src/schemas"
echo 'export const CreateTaskSchema = {};' > "$GOOD/src/schemas/task.ts"

# git history so --since works in both
for d in "$BAD" "$GOOD"; do
  ( cd "$d" || exit 99
    git init -q .
    git add -A
    git -c user.email=canary@example.invalid -c user.name=canary commit -qm canary )
done

# --- assertions ------------------------------------------------------------

note "=== canary 1: defective repo MUST fail ==="
if run_gate "$BAD"; then
  note "ASSERT FAILED: gate exited 0 on a repo with every defect present"
  FAILED=1
else
  note "ok — gate blocked the defective repo (exit $GATE_STATUS)"
fi

# Each seeded defect must be individually reported, or the gate is failing for the wrong reason.
for expect in \
  "agent card missing" \
  "no idempotency mechanism" \
  "no evidence its tool schemas are generated" \
  "vendor LLM endpoint or SDK referenced outside" \
  "no scope/permission model"
do
  if printf '%s' "$GATE_OUT" | grep -qF "$expect"; then
    note "ok — reported: $expect"
  else
    note "ASSERT FAILED: seeded defect not reported: $expect"
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /'
    FAILED=1
  fi
done

note ""
note "=== canary 2: compliant repo MUST pass ==="
if run_gate "$GOOD"; then
  note "ok — gate passed the compliant repo"
else
  note "ASSERT FAILED: gate blocked a compliant repo — false positive"
  printf '%s\n' "$GATE_OUT" | sed 's/^/    /'
  FAILED=1
fi

note ""
note "=== canary 3: warn mode reports but does not block ==="
AGENT_READINESS_ENFORCE=warn
export AGENT_READINESS_ENFORCE
if run_gate "$BAD"; then
  note "ok — warn mode exits 0 on the defective repo"
  # warn mode must still REPORT, or it is silent rather than non-blocking
  if printf '%s' "$GATE_OUT" | grep -q "agent card missing"; then
    note "ok — warn mode still reports its findings"
  else
    note "ASSERT FAILED: warn mode reported nothing — it must report, just not block"
    FAILED=1
  fi
else
  note "ASSERT FAILED: AGENT_READINESS_ENFORCE=warn still blocked (exit $GATE_STATUS)"
  FAILED=1
fi
unset AGENT_READINESS_ENFORCE

note ""
note "=== canary 4: --since drift check runs against a real base SHA ==="
BASE="$(cd "$GOOD" || exit 99; git rev-parse HEAD)"
mkdir -p "$GOOD/app/api/projects"
cat > "$GOOD/app/api/projects/route.ts" <<'EOF'
export async function POST(req: Request) { return Response.json({ ok: true }); }
EOF
( cd "$GOOD" || exit 99
  git add -A
  git -c user.email=canary@example.invalid -c user.name=canary \
      commit -qm "feat(api): add projects mutation, forget the MCP tool" )

run_gate "$GOOD" --since "$BASE" || true
if printf '%s' "$GATE_OUT" | grep -q "did not handle an idempotency key\|changed the API surface"; then
  note "ok — drift/regression detected on an incremental change"
else
  note "ASSERT FAILED: --since missed an unidempotent new mutation route"
  printf '%s\n' "$GATE_OUT" | sed 's/^/    /'
  FAILED=1
fi

note ""
if [ "$FAILED" -ne 0 ]; then
  note "check-agent-readiness.test.sh: FAILED — the gate is not trustworthy; do not rely on it in CI."
  exit 1
fi
note "check-agent-readiness.test.sh: all canaries passed (gate fails the bad, passes the good, warn + --since modes work)."
exit 0
