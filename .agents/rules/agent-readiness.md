<!-- MODULE:agent — KEEP IF the app should be usable by an AI agent (a harness such as Hermes, OpenClaw, any agent) as well as by a human in its own UI. DELETE otherwise. -->

# Agent Readiness (dual-mode apps)

> **Applies when:** the app is expected to work both under a human in its own UI *and* under an AI agent — either driven by an external harness, or autonomously with nothing but an LLM API key.
> **Delete this file (and its `@` import in the generated agent hub) if:** the app is a human-only surface with no programmatic consumer and none planned.

## The premise

Software is acquiring a second user. Alongside the human clicking through the UI there is an agent — a harness like Hermes or OpenClaw, an autonomous loop, or another service's agent — that needs to do the same work without a browser, without eyes, and without patience for ambiguity. That agent is not a hypothetical future consumer: it is a client class, and like every client class it has hard requirements.

The design consequence is one sentence: **the UI is a client of the API, never the owner of a capability.** Anything a human can do in the app, an agent must be able to do headlessly through a published surface. A capability that exists only as a button handler does not exist as far as an agent is concerned — and, by the same token, does not exist for your own background jobs, your CLI, your tests, or the next UI you build.

This is not an "AI features" module. `ai-features.md` governs the app *calling* a model. This governs the app *being called by* one. They are different problems with different rules, and an app can need both, either, or neither.

**Dual-mode means both modes are first-class.** The app must:

1. **Stand alone with only an LLM API key.** Point it at any OpenAI-compatible endpoint — a vendor directly, or a gateway such as LiteLLM — and every model-dependent feature works. No harness required, no account with a third party required.
2. **Be drivable by a harness.** Expose its capabilities over the standard agent surfaces so an external agent can discover and use them without a bespoke integration written per app.

Failing mode 1 makes the app unrunnable for a solo user. Failing mode 2 makes the app invisible to agents. Both are required.

## The three surfaces — non-negotiable minimum

An agent can only use an app if it can **discover** it, **call** it deterministically, and **delegate** to it. Each surface answers one of those, and they are layered — you cannot skip the lower one.

| Surface | Answers | Minimum bar |
| --- | --- | --- |
| **HTTP API** | *call it* | Every mutation reachable as a typed JSON endpoint with an idempotency key and a machine-readable error code. Inherits all of `api-design.md`. |
| **MCP server** | *use its capabilities* | A thin MCP adapter exposing those endpoints as tools, with schemas **generated from the API's own validation schemas**. Lives at a documented, reachable transport (Streamable HTTP for remote, stdio for local). |
| **A2A agent card** | *discover + delegate* | `/.well-known/agent-card.json` served by the app, declaring identity, endpoint, auth schemes, protocol version, and skills. Signed if the app participates in cross-organization delegation. |

MCP and A2A are complementary, not competing: MCP is agent-to-tool (the caller orchestrates and consumes capabilities), A2A is agent-to-agent (the remote agent keeps its own plan, memory, and execution and reports back over a stateful task). An app that exposes both lets a harness treat it as a toolbox *or* delegate a goal to it, whichever fits the interaction. Start with the HTTP API and MCP; add the A2A card the moment anything needs to discover the app rather than be pointed at it.

## Where these sit in Clean Architecture

**All three surfaces are Interface Adapters. None of them may contain a business rule.**

This is the property that keeps agent-readiness cheap instead of a rewrite. The HTTP handler, the MCP tool, and the A2A task handler are three adapters over the *same* use cases — they parse a request in a different vocabulary, call one use case, and map the result to a different response shape. Deleting all three would lose zero business logic.

The mechanical consequences:

- **The MCP server never reimplements anything.** If an MCP tool contains a rule, a query, or a calculation, that logic is duplicated and will drift from the HTTP path. It calls the use case the HTTP handler calls. When a tool needs data the use case does not return, extend the use case — do not bolt a second query into the adapter.
- **The A2A handler is a task adapter.** It maps a delegated goal onto use cases and reports state transitions. It does not decide what the app does.
- **Provider SDKs stay behind ports** exactly as `ai-features.md` requires for model calls. Nothing inward of the adapter names a harness, an MCP library, or an agent framework.

## Rules

### The HTTP API is the foundation

- **Full parity with the UI.** Every action the UI can perform is an endpoint. A screen-only action is a capability the app does not have. Audit by walking the UI's command surface and naming the endpoint for each; the gaps are the work.
- **Idempotency keys on every mutation.** Agents retry — on timeout, on ambiguous error, on a model deciding to try again. Without idempotency a retry is a duplicate record, a double charge, a second send. Accept a client-supplied key (`Idempotency-Key` header or an explicit field), persist it with the result, and return the original result on replay rather than re-executing. This is the single highest-value rule in this module: it is the difference between an agent that can be trusted with writes and one that cannot.
- **Structured errors an agent can act on.** A stable machine-readable code, a human message, and — critically for agents — enough signal to distinguish *retry* from *fix your input* from *give up*. A bare 500 with a stack trace costs an agent a full reasoning loop to interpret; `{"code":"validation_failed","fields":[{"name":"due_date","issue":"past_date"}]}` costs it nothing. Inherit the typed error shape from `api-design.md` and `error-handling.md`; never return 200 with an error body.
- **Machine-readable pagination, filtering, and sorting on every collection.** An agent cannot scroll and cannot see "Load more". the agent-based paging with a stable next-token, plus declared filter/sort parameters, so an agent can enumerate a whole collection deterministically.
- **Schema-published responses.** Types generated from the same validation schemas that enforce them, so the documented contract cannot disagree with the running code. This is also what lets the MCP layer generate its tool schemas instead of hand-writing a second copy.

### The MCP server

- **Schemas are generated, never hand-maintained.** A hand-written MCP tool schema is a second source of truth and it will drift — silently, because nothing tests the drift. Generate tool input/output schemas from the API's validation schemas (zod, pydantic, JSON Schema) in the same build step that generates the API types.
- **Tool descriptions are written for a model, not a developer.** The description *is* the affordance: an agent picks tools by reading them. State what the tool does, when to choose it, what each parameter means, and what comes back. Name the tool for the user-visible outcome (`create_task`), not the internal operation (`insertTaskRow`).
- **One tool per meaningful capability, not one per endpoint.** Blindly mirroring every route produces a tool list too long for a model to reason over and too granular to complete a goal. Group where the user's intent is one action; split where a single route serves genuinely different intents.
- **Expose read models as resources where the harness supports them.** State an agent will re-read often (a record, a list, a config) belongs in MCP resources/prompts, not only in tools, so the harness can cache and re-fetch it without burning a reasoning turn.
- **Surface failures as tool results, not transport errors.** An agent recovers from a well-formed "this failed because X" result; it flails at a dropped connection. Validate, catch, and return a structured error the model can act on.

### The A2A surface

- **Serve the agent card at the well-known path** (`/.well-known/agent-card.json`), reachable without authentication — it is the discovery document, and a card behind a login cannot be found. Declare: identity, the protocol version, the service endpoint, supported transports, auth schemes, and the skills the agent can delegate to.
- **Skills are described in outcome terms with their I/O and auth requirements**, so a delegating agent can decide fit without reading your source.
- **Long-running work is a stateful task, not a blocking request.** Agents delegate goals that take minutes. Return a task immediately, expose status, stream or allow polling for updates, support cancellation, and emit artifacts as the concrete output. Never hold an HTTP connection open for the duration of real work.
- **Support human-in-the-loop pauses.** A delegated task that needs a decision the agent cannot make must be able to enter an input-required state and resume, rather than fail or guess.

### LLM configuration — bring-your-own-key, gateway-agnostic

- **Configure through OpenAI-compatible environment variables only.** `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (plus optional `LLM_EMBEDDING_MODEL`, timeouts, and ceilings). One base URL and one key must be enough to run every model-dependent feature.
- **Never hardcode a vendor endpoint or import a vendor SDK outside its adapter.** A hardcoded `api.openai.com` breaks the gateway case; a vendor SDK inside feature code breaks the swap. Everything routes through the one internal client `ai-features.md` requires.
- **Works with a raw vendor key, a self-hosted gateway, or a harness-provided endpoint — identical code path.** If the app can only run against one of the three, it is not dual-mode.
- **Degrade, do not crash, when no key is present.** Every model-dependent feature reports "not configured" through the normal typed-error shape and the rest of the app works. An agent exploring an app should not take the whole process down by touching an unconfigured feature.
- **Never require an account with a third party to run the app.** A signup wall in front of basic operation is the same failure as a hardcoded vendor.

### Agent identity, permissions, and trust

- **An agent is a distinct principal.** Issue scoped API keys (or OAuth client credentials) for non-human callers — never have an agent log in as a human user or drive a browser session. A key identifies *which agent*, so its actions are attributable.
- **Scopes are real and enforced per record**, not a label. An agent key gets the least privilege its task needs: read-only for exploration, narrow write scopes for action. Enforce at the boundary *and* in the use case, since a second entrypoint (MCP, A2A, job) skips the first.
- **Rate limits and cost ceilings per principal.** An agent in a loop can do in seconds what a human could not do in a year. Limit by key, return `429` with a retry-after, and make the limit discoverable.
- **Everything an agent does is visible in the human UI.** Record the acting principal on every mutation and surface it: an activity log, a badge on records the agent touched, a dedicated "agent activity" view. **Trust requires visibility** — a human who cannot see what the agent did cannot trust the app, and will disable the integration. This is a product requirement, not a compliance nicety.
- **Provenance on agent-written data**, per `ai-features.md`: which agent, which model version, which prompt version, when, and whether a human accepted or overrode it.
- **Reversible by default.** Prefer soft-delete and audit-logged updates for agent-initiated writes. An agent that cannot be undone is an agent nobody enables.
- **Guard against prompt injection crossing the boundary.** Content an agent fetched from outside is untrusted input, not an instruction. Never let a value that arrived from an LLM, a webhook, or a scraped page authorize a privileged action on its own — the authorization decision is made by the use case against the authenticated principal's scopes, full stop.

## Verification — what "agent-ready" means in CI

Prose does not hold a line; a required CI gate does (see AGENTS.md → "Enforcement — the honest version"). `scripts/check-agent-readiness.sh` is the mechanical floor, and it checks what can be checked without judgement:

- the agent card exists and is valid JSON declaring the required fields, and sits in a path that is served at the well-known path (the gate judges the path's *shape* — `public/.well-known/`, a route handler, an API dir — it does not fetch the card; JSON validation SKIPs loudly rather than passing when no `jq`/`python3`/`node` is present);
- a mutation surface exists **and** an idempotency mechanism is global (a middleware/plugin/lib path) or named in each mutation file — static, best-effort detection, not a per-route runtime proof;
- the MCP tool schemas are **generated** (a generation helper is present), not hand-written — the gate does NOT verify the generated output is in sync with the API schemas;
- no vendor LLM **endpoint or vendor SDK import** is hardcoded outside the LLM adapter — the gate does not pattern-match model identifiers;
- a non-human principal exists (API-key / service-token auth) with a scope or permission model alongside it;
- with `--since <base>`: an agent-surface change (API/MCP/card) shipped without its counterpart or its doc update in the same change.

The gate is opt-out (`AGENT_READINESS=off`, for a repo that pruned the module and left the script) and warn-able (`AGENT_READINESS_ENFORCE=warn`, for a repo mid-adoption — never leave it on; it reports without blocking, which makes it a silent gate). Both knobs are working defaults; set only what your repo deviates from.

**What the gate canNOT check — do these yourself, or the green run means nothing:**

- that the generated MCP schemas are genuinely **in sync with the API schemas** (only that generation exists);
- that the app **starts and works with only `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` set** — the standalone-with-one-key proof. The gate never runs the app;
- that a mutation route's idempotency key is actually wired end to end, only that a mechanism is reachable from the file.

The parts that need judgement are the review checklist below and the **agent-perspective smoke test**: point a real harness at the app with a fresh scoped key and attempt a representative goal end to end — discover, read, write, observe the write in the UI, undo it. Do this before calling an app agent-ready, and record the result in the plan doc. A gate that passes while a real agent cannot complete a task is a gate measuring the wrong thing.

## Review checklist

- [ ] Every capability reachable in the UI is reachable through the API; I walked the UI and named the endpoint for each action.
- [ ] Every mutation accepts an idempotency key and replays the original result instead of re-executing.
- [ ] Every error an agent can hit carries a machine-readable code that distinguishes retry / fix-input / give-up.
- [ ] Every collection supports cursor pagination plus declared filter and sort parameters.
- [ ] The MCP server contains no business rule — only parsing, a use-case call, and response mapping.
- [ ] MCP tool schemas are generated from the API's validation schemas, and the generation runs in CI.
- [ ] Tool names and descriptions read as user-visible outcomes and would let a model pick correctly without source access.
- [ ] `/.well-known/agent-card.json` is served unauthenticated, validates, and declares endpoint, auth schemes, version, and skills.
- [ ] Long-running delegated work returns a stateful task with status, streaming or polling, and cancellation — no request held open.
- [ ] A task that needs human input can pause and resume rather than fail or guess.
- [ ] LLM access is configured solely by `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`; no vendor endpoint or model ID appears outside the adapter.
- [ ] The app runs with no LLM key set — unconfigured features degrade through the typed-error shape, nothing crashes.
- [ ] Non-human callers authenticate with their own scoped keys, never a human session; scopes are enforced in the use case, not only the route.
- [ ] Rate limits and cost ceilings exist per principal and return a discoverable retry signal.
- [ ] Agent-initiated writes are attributable in the human UI and reversible (soft-delete / audit log).
- [ ] Untrusted content crossing the boundary cannot authorize a privileged action by itself.
- [ ] A real harness completed a representative goal end to end against this app, and the result is recorded in the plan doc.

## Anti-patterns

- **A bolt-on MCP server that reimplements logic.** It drifts from the API within weeks and then two code paths disagree about what the app does. MCP is an adapter.
- **"Agent mode" as a separate feature.** A toggle that exposes a subset of capabilities to agents builds a second, worse app. Make the primary surface agent-readable.
- **Screen-scraping as the integration path.** If the only way for an agent to use the app is to drive its UI, the app has no API — it has a puppet. Publish the surface instead.
- **The UI as the only client.** Business rules inside components or handlers are invisible to every other consumer (agents, jobs, CLI, tests) and are the layering violation `clean-architecture.md` already forbids.
- **A vendor-locked LLM config.** Requiring one provider's key and endpoint breaks gateway users, self-hosters, and anyone whose harness supplies its own model access.
- **Unattributed agent writes.** Records that changed and nobody can say what changed them: the human loses trust, disables the integration, and the capability is wasted.
- **Hand-written MCP schemas.** Two sources of truth for one contract, with no test detecting the divergence.
- **Idempotency deferred to "later".** It is cheap at design time and expensive as a retrofit, and until it lands an agent must be treated as unsafe for writes — which is most of the value.

<!-- /MODULE:agent -->
