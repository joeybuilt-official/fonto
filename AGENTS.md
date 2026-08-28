# AGENTS.md — fonto

Canonical, provider-neutral instructions for ANY coding agent or LLM working in this repo
(Claude Code, OpenAI Codex, Cursor, Gemini, GitHub Copilot, Windsurf, Cline, aider, …).
If you are Claude Code, `CLAUDE.md` imports this file — read it as your hub.

The tool-native files (`.cursor/rules/`, `.clinerules/`, `.windsurf/rules/`,
`.github/copilot-instructions.md`, `GEMINI.md`, `CONVENTIONS.md`) are **generated** from the
`MIRROR` block below. Do not edit them; edit `AGENTS.md` and run `sh scripts/sync-agents.sh`.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Project hard rules (preserved)

- PlexoConnectionStatus is in the dashboard layout — never add it to individual pages.
- All AI routes through Plexo (`@joeybuilt/plexo-sdk`); never pin an AI provider/model locally. `pnpm conformance` fails on drift.

## Start here — onboarding contract (read in this order, before writing anything)

This is the exact order a new agent reads, whatever tool you are. It maps 1:1 to the four things you
must do: **find the context**, **not break anything**, **carry existing work forward**, **make new
work fit**.

1. **This file (`AGENTS.md`)** — the map and the non-negotiables below.
2. **`docs/claude/roadmap.md`** — the overall plan: the initiatives this project is committed to, in
   Now / Next / Later. This is the strategic arc — what we are building and where we are in it.
3. **`docs/claude/in-progress.md`** — the tactical queue that rolls up into the roadmap: what is in
   flight, what is next, and the *exact next step* to resume cold. **Carry these initiatives forward;
   do NOT open a parallel track for work already queued here.**
4. **The running worklog** — `docs/claude/worklog.md`. Skim what landed recently. You will append one
   line here in the same change as your work (see Non-negotiables).
5. **`CLAUDE.md`** — project overview, tech stack, the real command table, and the directory map.
   Plain markdown; read it even if you are not Claude. It lists the rule modules as `@.claude/rules/*.md`.
6. **`.claude/rules/clean-architecture.md`** — the architecture premise every change obeys (below).
7. **The `.claude/rules/` module governing what you are about to touch** — `testing.md`, `database.md`,
   `api-design.md`, `frontend.md`, `error-handling.md`, etc. Plain markdown; open the one that applies.
8. **`docs/claude/architecture.md`** and **`key-patterns.md`** — decisions and gotchas, so you extend
   the design instead of re-litigating it.

Then: **carry the plan forward**, **keep the roadmap/plan/worklog current in the SAME change as the
work**, and **verify (test + typecheck + lint + `pnpm arch`) before you commit.**
Full doctrine: `.claude/rules/workflow.md` and `.claude/rules/documentation.md`.

In a monorepo the closest `AGENTS.md` to the file you are editing wins; this root file is the default.

## Non-negotiables

- **Clean Architecture is the premise of all code here.** Dependencies point inward only; business
  rules never import a framework, ORM, HTTP client, or vendor SDK; every external concern sits behind
  a port with its adapter at the edge; one composition root wires them. fonto is feature-sliced under
  `lib/` and not yet fully conformant — name the layers your change touches and do not add new outward
  imports. Full rule + review checklist: `.claude/rules/clean-architecture.md`.
- **Verify before commit.** No commit without a green `pnpm typecheck` + `pnpm lint` + `pnpm arch`
  (and `pnpm test:e2e` where the change touches a tested path) in the same session.
- **The plan and worklog are never stale.** Every change updates `docs/claude/in-progress.md` (its
  status + Next step), appends one line to `docs/claude/worklog.md`, and moves the `roadmap.md`
  initiative when it starts or ships — all in the same commit as the code. Shipped-but-unlogged counts
  as not done. Full doctrine: `.claude/rules/documentation.md`.

## Architecture is non-negotiable

This project is built on Clean Architecture. Every change — planned or written, by any human or AI
agent, in any tool — obeys one rule: **source-code dependencies point inward only.** Business rules
(Entities / Domain, Use Cases / Application) never import a framework, ORM, HTTP client, UI library,
vendor SDK, or environment/config. Every external concern sits behind a **port** (an interface
declared in the use-case layer) implemented by an **adapter** at the edge.

- You **MUST** place each new piece in one of the four layers and keep its imports pointing inward.
  The layer→directory map is in `.claude/rules/clean-architecture.md` → "This project's layers".
- You **MUST NOT** put a business rule in a route handler (`app/api/**`), UI component, database
  trigger, or ORM lifecycle hook.
- You **MUST NOT** serialize a domain entity to the wire or persist one by ORM reflection — map to a
  DTO at the boundary.
- The exemplar is `lib/intelligence` (ports + adapters, ADR-002), enforced by `pnpm arch`. The rest of
  `lib/` is feature-sliced and only partly conformant — do not add to the gap.

<!-- MIRROR:start — this block is copied verbatim into every tool-native file by scripts/sync-agents.sh. Edit here only; it is the "if you read nothing else" contract for tools that do not open AGENTS.md. -->
## If you read nothing else in this repo

**Before writing anything, open `AGENTS.md` at the repo root and read it fully.** The short version:

- **Read, in order:** `docs/claude/roadmap.md` (the plan) → `docs/claude/in-progress.md` (the queue +
  the exact next step) → `docs/claude/worklog.md` (what landed) → `CLAUDE.md` (stack + commands) → the
  `.claude/rules/` module for what you touch.
- **Carry existing work forward.** The top of `in-progress.md` is the live task with its next step —
  continue it; do NOT open a parallel track for work already queued.
- **Keep the plan and worklog current in the SAME change as the code.** Shipped-but-unlogged = not done.
- **Clean Architecture is mandatory:** dependencies point inward only; business rules import no
  framework / ORM / HTTP / SDK; external concerns sit behind a port with an edge adapter.
- **All AI goes through Plexo** (`@joeybuilt/plexo-sdk`) — never pin a provider/model locally; `pnpm conformance` fails on drift.

### MUST NOT — hard guardrails

For Claude Code these are enforced by `.claude/settings.json`. **That permission gate binds only
Claude** — for every other tool these are advisory doctrine, and the only cross-tool enforcement is
whatever the repo has wired server-side (branch protection + required CI). Honor them as absolute:

- **NEVER** force-push, `git reset --hard` a shared branch, delete branches/tags, or rewrite published
  history.
- **NEVER** run a destructive database command: `drizzle-kit push` / `db:push`, `db:reset`, `db:drop`,
  or raw `DROP`. Migrations are forward-only (`pnpm db:generate` then `pnpm db:migrate`) and reviewed.
- **NEVER** pipe the network to a shell (`curl … | bash`, `iwr … | iex`) or install from an untrusted
  source.
- **NEVER** read or print secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`), and never put a
  credential in a git remote URL or a commit.
- **NEVER** publish a package or deploy (`npm publish`, `docker push`, …) unless the task explicitly
  asks and a human has approved.
- **ALWAYS** stop and get human approval before any change that is destructive, irreversible, or
  outside the approved scope.
<!-- MIRROR:end -->

## Where everything lives

| You need | Read |
|---|---|
| The overall plan (initiatives) | `docs/claude/roadmap.md` |
| What to work on now | `docs/claude/in-progress.md` |
| What landed recently | `docs/claude/worklog.md` |
| How to work (process) | `.claude/rules/workflow.md`, `quality-bar.md`, `git-workflow.md`, `documentation.md` |
| Architecture premise | `.claude/rules/clean-architecture.md` |
| Code / tests / errors | `.claude/rules/code-style.md`, `testing.md`, `error-handling.md` |
| Data & interfaces | `.claude/rules/database.md`, `data-modeling.md`, `api-design.md` |
| Stack, commands, structure | `CLAUDE.md` |
| Decisions & gotchas | `docs/claude/architecture.md`, `key-patterns.md`, `adr/`, `docs/adr/` |

Deep rules are **not copied here** — they live once under `.claude/rules/` and are plain markdown any
agent can open. This file is the index, the onboarding order, and the guardrail; the modules are the depth.

## Enforcement — the honest version

Be clear-eyed about what actually stops a bad change, because half of these tools have no permission
model at all:

- **`.claude/settings.json`** is a real gate, but it binds **only Claude Code**. It does nothing to a
  Cursor, Codex, Copilot, Windsurf, Cline, or aider agent.
- For every other tool, the guardrails above are **doc-level MUST-NOT prose** — always in context (the
  `MIRROR` block is mirrored into each tool's native rules file), but advisory.
- **The only cross-tool enforcement is server-side:** branch protection on `main` (blocks force-push
  and direct pushes) and **required CI status checks** (typecheck, lint, test, `pnpm arch`,
  `pnpm conformance`, secret scan) that block a merge regardless of tool. This repo has **no CI yet** —
  a starter workflow is at `scripts/templates/ci-verify.yml` and a pre-commit sample at
  `scripts/templates/pre-commit`; **copy them in and mark the checks required.** Until you do, the only
  backstop against a non-Claude agent is the prose above.
