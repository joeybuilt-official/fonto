# AGENTS.md — Fonto

Canonical, provider-neutral instructions for ANY coding agent or LLM working in this repo
(any agent).
`AGENTS.md` is the canonical hub; the generated agent hub imports this file.

The tool-native generated mirrors carry the `MIRROR` block below (the universal preamble) followed by a
generated **index** of the rule modules (name → what it governs → path) — never a second copy of the
rule text, which lives once under `.agents/rules/*.md`. What "self-contained" means differs by format,
and `scripts/sync-agents.sh` is the single home for that distinction:

- **Single-file mirrors** (`CLAUDE.md`, `.github/copilot-instructions.md`, `GEMINI.md`,
  `CONVENTIONS.md`, `.clinerules/`, `.windsurf/`) carry the **index only**. Inlining every body made a
  ~184KB file that harnesses **silently truncated** at their cap, so it was neither small nor complete
  while claiming to be both — the same defect `AGENTS.md` had already shed. They point at the modules,
  which any tool with file access can open.
- **Per-rule modules** (`.cursor/rules/*.mdc`, `.agents/rules/*.mdc`) carry each rule's **FULL body**
  verbatim, one rule per file, scoped by the rule's own `Applies when:` condition.

This file is the hub those tools read: the preamble, the guardrails, and the same generated index
between the `PANOPLY:RULES` markers. Do not edit the generated files or the marked block; edit
`AGENTS.md` (preamble) or `.agents/rules/*.md` (bodies) and run `sh scripts/sync-agents.sh`.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your
training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.
Heed deprecation notices. The version this repo pins is in `package.json`; do not assume the API you
remember from an earlier major.
<!-- END:nextjs-agent-rules -->

## What Fonto is

Fonto is an AI-classified digital asset manager for photos, documents, and scans, with unified search and self-hosted storage.

**Core pillars**: universal asset intake; trustworthy AI enrichment; unified search and metadata; user-owned, reversible storage workflows.

**Core pillars**: universal asset intake; trustworthy AI enrichment; unified search and metadata;
user-owned, reversible storage workflows.

## Tech Stack

- **Language / runtime**: TypeScript on Node.js 22 (Dockerfiles); Flutter SDK >=3.22 for mobile
- **Package manager**: pnpm 10 (`pnpm-lock.yaml`; lockfile version 9)
- **Client**: Next.js 16 App Router + React 19 + Tailwind CSS 4/shadcn/Base UI; Flutter app under `mobile/`
- **Server**: Next.js Node server + REST route handlers, BullMQ worker, and Express Bull Board sidecar
- **Data**: PostgreSQL with Drizzle ORM and pgvector; Cloudflare R2/S3-compatible storage; Redis/Valkey queues
- **Workspace layout**: root app plus `packages/fonto-sdk` under `packages/*`; use pnpm's `--filter @joeybuilt/fonto-sdk` selector for SDK tasks

## Key Commands

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Dev | `pnpm dev` |
| Test | `pnpm test:e2e` |
| Typecheck / static analysis | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Build | `pnpm build` |
| Architecture boundary check | `pnpm arch` |
| Endpoint coverage check | `pnpm tsx scripts/check-endpoint-tests.ts` |
| OpenAPI registration check | `pnpm tsx scripts/check-openapi-coverage.ts --strict` |
| Generate migration | `pnpm db:generate` |
| Apply migration | `pnpm db:migrate` |

| Landing gates the kit added | `sh scripts/panoply.sh check` · `sh scripts/sync-agents.sh --check` · `sh scripts/check-docs.sh --since origin/main` |
| Kit self-tests | `sh scripts/panoply.test.sh` (and each `scripts/check-*.test.sh` canary) |

The SDK test command is `pnpm --filter @joeybuilt/fonto-sdk test`.

## Project Structure

```
app/                 Next.js routes, layouts, pages, and API handlers
  api/               HTTP route handlers; v1 contracts are registered in lib/openapi/
components/          Shared React components; components/ui/ holds primitives
lib/                 Feature logic, integrations, persistence, and processing
  db/                Drizzle client, schema, and SQL helpers
  intelligence/      Intelligence ports, registry, and vendor adapters
drizzle/             Generated database migrations
  migrations/        Forward-only SQL migration history
packages/             pnpm workspace packages
  fonto-sdk/          Published TypeScript SDK
mobile/              Flutter client
  lib/                Dart application source
e2e/                 Playwright browser tests
worker/              BullMQ worker process
ops/                 Monitoring, autoscaling, backups, and operations
scripts/              Maintenance and verification scripts
```

## Hard rules in this repo

- AI credentials are encrypted at rest through `lib/crypto/secret-box.ts`; never store or log a
  plaintext key. AI connection settings live in Settings → Integrations.
- Every `/api/v1` route change updates `lib/openapi/routes.ts` and passes the OpenAPI registration
  check.
- Database changes use generated Drizzle migrations. Never `pnpm db:push` against a live database.
- **Clean Architecture is enforced mechanically here:** `pnpm arch` (dependency-cruiser) fails the
  build on an outward import, and every layer rule is `error`. A violation is fixed or baselined in
  `.dependency-cruiser-known-violations.json` — the baseline may shrink, never grow. Plan:
  `docs/agents/architecture-gate/plan.md`.

## Start here — onboarding contract (read in this order, before writing anything)

This is the exact order a new agent reads, whatever tool you are. It maps 1:1 to the four things you
must do: **find the context**, **not break anything**, **carry existing work forward**, **make new
work fit**.

1. **This file (`AGENTS.md`)** — the map and the non-negotiables below.
2. **`docs/agents/roadmap.md`** — the overall plan: the initiatives this project is committed to, in
   Now / Next / Later. This is the strategic arc — what we are building and where we are in it.
3. **`docs/agents/in-progress.md`** — the tactical queue that rolls up into the roadmap: what is in
   flight, what is next, and the *exact next step* to resume cold. **Carry these initiatives forward;
   do NOT open a parallel track for work already queued here.**
4. **The running worklog** — `docs/agents/worklog.md`, or this repo's `CHANGELOG.md` / `HISTORY.md`
   `[Unreleased]` section if it keeps one instead. Skim what landed recently. You will append one line
   here in the same change as your work (see Non-negotiables).
5. **`AGENTS.md`** — project overview, tech stack, the real command table, and the directory map. `AGENTS.md` is canonical; the generated agent hub.
   Plain markdown; read it even if you are not the agent. It lists the rule modules as `@.agents/rules/*.md`.
6. **`.agents/rules/clean-architecture.md`** — the architecture premise every change obeys (below).
7. **The `.agents/rules/` module governing what you are about to touch** — `testing.md`, `database.md`,
   `api-design.md`, `frontend.md`, `error-handling.md`, etc. Plain markdown; open the one that applies.
8. **`docs/agents/architecture.md`** and **`key-patterns.md`** — decisions and gotchas, so you extend
   the design instead of re-litigating it.

Then: **propose before you edit**, **keep the roadmap/plan/worklog current in the SAME change as the
work**, and **verify (test + typecheck + lint + the architecture-boundary check) before you commit.**
Run the **Algorithm pass** — question every requirement (name its requester), **delete what you can**,
simplify, accelerate, automate last, in that order — before proposing anything structural; every plan
owes a **deletion candidate list**, because deleting is the one step that leaves no artifact and is
therefore the one that gets skipped. Full doctrine: `.agents/rules/algorithm.md`, `workflow.md`, and
`.agents/rules/documentation.md`.

**Write the spec before the plan, on anything structural.** `docs/agents/<area>/<feature>/spec.md` — a
sibling of the plan — states what a user can DO after this ships and how we will know it worked:
prioritized user stories, each with an **independent test**, Given/When/Then acceptance scenarios, and
numbered `MUST` requirements. It also names the **industry/domain** the software is built for and
records **which outside experts were consulted and what they said** — the filmmaker for a film tool,
the restaurateur for a restaurant tool — with UI/UX as a *planning* input, not a review afterthought
(two persona files, `ux-designer` and `ux-researcher`, are the invocations). Convenience no longer
carries: software-role input is not domain input. An unknown is written `[NEEDS CLARIFICATION:
<question>]` **and lives only in a draft spec** — resolve it (or delete the requirement) before
`plan.md` exists, because an ambiguity that reaches the plan has already become an unreviewed guess.
`scripts/check-spec.sh` refuses a structural change with no spec, or with a marker still unresolved.
**Placeholders until a real person was consulted — never a fabricated quote.** Routine work inside an
existing pattern is exempt; say so. Full doctrine: `.agents/rules/spec.md`.

In a monorepo the closest `AGENTS.md` to the file you are editing wins; this root file is the default.

## Non-negotiables

- **Clean Architecture is the premise of all code here.** Dependencies point inward only; business
  rules never import a framework, ORM, HTTP client, or vendor SDK; every external concern sits behind
  a port with its adapter at the edge; one composition root wires them. Name the layers your change
  touches before you write it. Full rule + review checklist: `.agents/rules/clean-architecture.md`.
- **Plan before code; verify before commit.** No multi-file change without a persisted plan under
  `docs/agents/`; no commit without a green test / typecheck / lint run in the same session.
- **The plan and worklog are never stale — and this is enforced, not just asked.** Every change
  updates `docs/agents/in-progress.md` (its status + Next step), appends one line to the running
  worklog, and moves the `roadmap.md` initiative when it starts or ships — all in the same commit as
  the code. Shipped-but-unlogged counts as not done. **The landing gate `scripts/check-docs.sh` fails
  any commit that changes code but not the worklog in the same commit** — it runs in required CI, so
  no agent in any tool can land a code change without its doc update. Full doctrine:
  `.agents/rules/documentation.md`.

## Architecture is non-negotiable

This project is built on Clean Architecture. Every change — planned or written, by any human or AI
agent, in any tool — obeys one rule: **source-code dependencies point inward only.** Business rules
(Entities / Domain, Use Cases / Application) never import a framework, ORM, HTTP client, UI library,
vendor SDK, or environment/config. Every external concern sits behind a **port** (an interface
declared in the use-case layer) implemented by an **adapter** at the edge.

- You **MUST** place each new piece in one of the four layers and keep its imports pointing inward.
  The layer→directory map is in `.agents/rules/clean-architecture.md` → "This project's layers".
- You **MUST NOT** put a business rule in a controller, route handler, UI component, database trigger,
  or ORM lifecycle hook.
- You **MUST NOT** serialize a domain entity to the wire or persist one by ORM reflection — map to a
  DTO at the boundary.
- Before you build, state the layers you touch and the ports you add (the plan template forces this).
  If a new dependency would point outward, stop and raise it before writing the code.
- This is enforced **mechanically** where the project has wired it: the architecture-boundary check
  fails the build on an outward import. That check binds every contributor equally **only once it runs
  in required CI** — a client-side pre-commit hook is skippable with `--no-verify`, so CI is the plane
  that actually holds against a non-agent. See "Enforcement — the honest version" below.

<!-- MIRROR:start — this block is copied verbatim into every tool-native file by scripts/sync-agents.sh. Edit here only; it is the "if you read nothing else" contract for tools that do not open AGENTS.md. -->
## If you read nothing else in this repo

**Before writing anything, open `AGENTS.md` at the repo root and read it fully.** The short version:

- **Read, in order:** `docs/agents/roadmap.md` (the plan) → `docs/agents/in-progress.md` (the queue +
  the exact next step) → the running worklog (`docs/agents/worklog.md` or the `CHANGELOG`
  `[Unreleased]` section) → `AGENTS.md` (stack + commands) → the `.agents/rules/` module for what you
  touch.
- **Carry existing work forward.** The top of `in-progress.md` is the live task with its next step —
  continue it; do NOT open a parallel track for work already queued.
- **Keep the plan and worklog current in the SAME change as the code.** Shipped-but-unlogged = not done.
- **Clean Architecture is mandatory:** dependencies point inward only; business rules import no
  framework / ORM / HTTP / SDK; external concerns sit behind a port with an edge adapter.

### First touch — adopt the kit before you modify anything

**If this repository does not carry the Panoply kit, adopting it IS the first batch of work — never
skip it and never work around it.** Detect it with the kit's own machine surface, which any harness
can run (Hermes, any agent, CI — not just the agent):

    sh scripts/panoply.sh check          # 0 current · 10 not applied · 11 partial · 12 stale
                                         # 13 unadapted (placeholders left) · 14 mirrors drifted
                                         # 15 the DOCTOR ITSELF is stale — see below

A non-zero result means stop and adopt:

    sh scripts/panoply.sh migrate        # only if 15: carry an OLD-layout repo forward, then review
    sh scripts/panoply.sh apply          # deterministic seeding + the agent checklist
    sh scripts/sync-agents.sh            # regenerate every tool mirror
    sh scripts/panoply.sh check          # must exit 0 before other work begins

**Exit 15 (`SELF-STALE`) is special: this repo's `scripts/panoply.sh` is an older kit generation, so
EVERY verdict it prints is against a layout the current kit no longer uses** — the false green that
lets a drifted repo believe it is current. `migrate` translates an old-layout repo
(`docs/claude/` + `.claude/rules/`) onto the current one (`docs/agents/` + `.agents/rules/`), reports
the translation before performing it, and refreshes the doctor itself (backing up the old copy). It
never deletes the old tree — review it and remove it yourself. Nothing pulls from the network: a kit
fix is REVIEWED, never silently overwritten.

Do the judgement half the checklist names (fill every `{{TOKEN}}` from this project's OWN manifests,
prune the `MODULE:` blocks that do not apply, merge — never overwrite — a pre-existing
AGENTS.md`). A half-applied kit fails its own doc gate and looks like a doc bug, so
finish it or revert it; do not leave it partial. `apply` prints a per-file disposition
(`ADDED`/`KEPT`/`DRIFTED`/`FORCED`) and, when any managed file stays different from the kit, writes a
`<version>+drifted` stamp and exits 12 — a stamp certifies the state, never the attempt.
`PANOPLY_OFF=1` exists for a deliberate exception — say plainly that you used it, so the choice is
reviewed rather than assumed.

### MUST NOT — hard guardrails

For the agent these are enforced by `.agents/policy.md`. **That permission gate binds only
the agent** — for every other tool these are advisory doctrine, and the only cross-tool enforcement is
whatever the repo has wired server-side (branch protection + required CI). Honor them as absolute:

- **NEVER** force-push, `git reset --hard` a shared branch, delete branches/tags, or rewrite published
  history.
- **NEVER** run a destructive database command: `db:push` / `db:reset` / `db:drop`, `prisma db push`,
  `prisma migrate reset`, `drizzle-kit push`, `alembic downgrade base`, `supabase db reset`, or raw
  `DROP`. Migrations are forward-only and reviewed.
- **NEVER** pipe the network to a shell (`curl … | bash`, `iwr … | iex`) or install from an untrusted
  source.
- **NEVER** read or print secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`), and never put a
  credential in a git remote URL or a commit.
- **NEVER** publish a package or deploy (`npm publish`, `cargo publish`, `docker push`, …) unless the
  task explicitly asks and a human has approved.
- **ALWAYS** stop and get human approval before any change that is destructive, irreversible, or
  outside the approved scope.
<!-- MIRROR:end -->

## Where everything lives

| You need | Read |
|---|---|
| The overall plan (initiatives) | `docs/agents/roadmap.md` |
| What to work on now | `docs/agents/in-progress.md` |
| What landed recently | `docs/agents/worklog.md` (or `CHANGELOG.md` `[Unreleased]`) |
| How to work (process) | `.agents/rules/workflow.md`, `quality-bar.md`, `git-workflow.md`, `documentation.md` |
| Architecture premise | `.agents/rules/clean-architecture.md` |
| Whether a thing should exist at all (question/delete/simplify/accelerate/automate) | `.agents/rules/algorithm.md` |
| What a user can do after this ships, and how we'll know it worked | `.agents/rules/spec.md` + the feature's `spec.md` |
| Whether a claim a reader sees is real (stats, testimonials, metrics, fake terminal decoration) | `.agents/rules/claims.md` |
| How a comment should read, and what not to comment | `.agents/rules/code-style.md` → Comments |
| The industry/domain this is for, and which outside experts were consulted | the feature's `spec.md` → `## Domain & outside experts` |
| Planning personas (UX flows, behaviour evidence) | `.agents/personas/README.md` (`ux-designer`, `ux-researcher`) |
| Code / tests / errors | `.agents/rules/code-style.md`, `testing.md`, `error-handling.md` |
| Data & interfaces | `.agents/rules/database.md`, `data-modeling.md`, `api-design.md` |
| Stack, commands, structure | `AGENTS.md` |
| Decisions & gotchas | `docs/agents/architecture.md`, `key-patterns.md` |
| The architecture gate and its baseline | `docs/agents/architecture-gate/plan.md` |
| Is this repo's kit current? | `sh scripts/panoply.sh check` (0 = current) |

Deep rules are **not copied here** — they live once under `.agents/rules/` and are plain markdown any
agent can open. This file is the index, the onboarding order, and the guardrail; the modules are the depth.

## Enforcement — the honest version

Be clear-eyed about what actually stops a bad change, because half of these tools have no permission
model at all:

- **`.agents/policy.md`** is a real gate, but it binds **only the agent**. It does nothing to a
  any agent.
- For every other tool, the guardrails above are **doc-level MUST-NOT prose** — always in context (the
  `MIRROR` block is mirrored into each tool's native rules file), but advisory. A determined or
  confused agent can still run the command.
- **The only cross-tool enforcement is server-side:** branch protection on the default branch (blocks
  force-push and direct pushes no matter who typed them) and **required CI status checks** (test,
  typecheck, lint, the architecture-boundary check, secret scan) that block a merge regardless of tool.
  This repo ships a starter CI workflow at `scripts/templates/ci-verify.yml` and a pre-commit sample
  at `scripts/templates/pre-commit`; **turn them on and mark the CI checks required** — until you do,
  the only backstop against a non-agent is the prose above. Do not assume a gate you have not
  wired.

## The rules — an index, and one home for the text

Every `.agents/rules/` module is listed below (name → what it governs → the path to read), generated by
`scripts/sync-agents.sh` from the modules themselves. The **full text is not reproduced here** — it
lives once under `.agents/rules/*.md`, plain markdown any agent can open, so this file and the modules
cannot drift apart. A tool that reads `AGENTS.md` but cannot follow `@`-imports still gets the map: the
preamble above, this list, and the guardrails; open the module for the depth. The tool-native mirrors
are generated from the same source and split the same way `AGENTS.md` is: the **single-file** ones
(`CLAUDE.md`, Copilot, Gemini, …) carry this index, while the **per-rule** ones
(`.cursor/rules/*.mdc`) carry each rule's full body — `sync-agents.sh` names a file's format, never a
claim about its size. **Do not edit between the markers** — edit the modules and re-run
`sh scripts/sync-agents.sh` (`--check` fails CI if this block drifts).

<!-- PANOPLY:RULES:BEGIN — generated index from .agents/rules/*.md by scripts/sync-agents.sh. Edit the modules, not here. -->

- `algorithm` — The Algorithm: Question, Delete, Simplify, Accelerate, Automate — `.agents/rules/algorithm.md`
- `spec` — Spec before Plan — `.agents/rules/spec.md`
- `clean-architecture` — Clean Architecture — `.agents/rules/clean-architecture.md`
- `workflow` — Workflow: Change Approval & Planning — `.agents/rules/workflow.md`
- `quality-bar` — Long-Term Quality Bar — `.agents/rules/quality-bar.md`
- `git-workflow` — Git Workflow — `.agents/rules/git-workflow.md`
- `documentation` — Documentation & Memory — `.agents/rules/documentation.md`
- `code-style` — Code Style & Patterns — `.agents/rules/code-style.md`
- `testing` — Testing — `.agents/rules/testing.md`
- `error-handling` — Error Handling — `.agents/rules/error-handling.md`
- `database` — Database & Migrations — `.agents/rules/database.md`
- `data-modeling` — Data Modeling — `.agents/rules/data-modeling.md`
- `api-design` — API & Event Payload Design — `.agents/rules/api-design.md`
- `frontend` — Front-End Engineering — `.agents/rules/frontend.md`
- `design-system` — UI Design System — `.agents/rules/design-system.md`
- `claims` — Claims: Evidence Before Assertion — `.agents/rules/claims.md`
- `ai-features` — AI Features & Data Enrichment — `.agents/rules/ai-features.md`
- `agent-readiness` — Agent Readiness (dual-mode apps) — `.agents/rules/agent-readiness.md`
- `factory-phases` — The factory phases — `.agents/rules/factory-phases.md`
- `wireframe-first` — Wireframe before backend — `.agents/rules/wireframe-first.md`

<!-- PANOPLY:RULES:END -->
