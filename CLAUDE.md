# fonto — Claude Code Guidelines

## Project Overview

Self-hostable, AI-classified digital asset manager — photos, documents, and scans in one library,
auto-tagged, OCR'd, perceptually deduped, and searchable across every file type, on your own R2/S3
bucket and Postgres. Built on Plexo (AI gateway); runs standalone when Plexo is absent.

**Core pillars** _(inferred from README — confirm)_: data ownership (self-host on your own R2/S3 +
Postgres) · AI enrichment via Plexo that degrades gracefully when absent · one classification
pipeline, provenance-tracked · port/adapter discipline (Plexo behind `lib/intelligence`, ADR-002).

## Tech Stack

- **Language / runtime**: Node.js 20 · TypeScript 5 · Next.js 16 / React 19
- **Package manager**: pnpm
- **Client**: Next.js 16 (App Router, React 19), Tailwind CSS 4, shadcn/ui (base-nova), MapLibre, TanStack Virtual
- **Server**: Next.js route handlers + Express (Bull Board), BullMQ workers on Redis/Valkey, Effect, OpenTelemetry
- **Data**: PostgreSQL (schema `fonto`, pgvector) via Drizzle ORM; `postgres` / `pg` drivers; R2/S3 object storage
- **Workspace layout**: pnpm workspace (`packages/*`) — root Next.js app + `packages/fonto-sdk`. Separate deployables `worker/`, `cli/` (own manifests); `mobile/` is a Flutter app. Scope with `pnpm --filter <name>`.

## Key Commands

| Purpose | Command |
|---|---|
| Install | `pnpm install` |
| Dev | `pnpm dev` (port 3500) |
| Test (e2e) | `pnpm test:e2e` |
| Typecheck / static analysis | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Build | `pnpm build` |
| Architecture boundary check | `pnpm arch` (guards the `lib/intelligence` port catalog, ADR-002) |
| Plexo conformance guard | `pnpm conformance` |
| Generate migration | `pnpm db:generate` |
| Apply migration | `pnpm db:migrate` (forward-only; never `db:push`) |

## Project Structure

```
app/          Next.js App Router — (app), (auth), admin/, api/ (v1|auth|admin|export|health|metrics|plexo), mobile/, share/
components/    React UI — ui/ (shadcn primitives), auth/, plexo/, + product components (app-shell, app-sidebar, …)
lib/           Feature-sliced core — intelligence/ (ports + adapters, ADR-002), db/ (Drizzle schema + client),
               classify, faces, fusion, evidence, processing, queue, storage, tus, vectors, auth, authz, …
worker/        BullMQ background worker (own package.json)
ops/           Autoscaler + operational tooling
scripts/       tsx backfills/reprocessors, conformance-guard.mjs, sync-agents.sh
packages/      Workspace members — fonto-sdk (shared SDK)
mobile/        Flutter app (own toolchain — pubspec.yaml)
cli/           Standalone CLI (own package.json)
drizzle/       Generated SQL migrations
e2e/           Playwright specs + live probes
adr/  docs/adr/ Architecture Decision Records (two homes — see docs/claude/architecture.md)
```

## How We Work Together

The rules below are not suggestions. When a rule and a shortcut conflict, the rule wins — or you
raise the conflict explicitly and let me decide. Read the module that governs what you're touching
before you touch it.

@AGENTS.md

### Architecture — the premise everything else inherits from

**Clean Architecture is the premise of all coding efforts in this project.** Business rules live in
the core; the database, the web framework, the UI, and every vendor are replaceable details at the
edge; source-code dependencies point inward only. fonto is feature-sliced under `lib/` and does not
yet fully conform — see the layer map and gaps in `.claude/rules/clean-architecture.md` and
`docs/claude/architecture.md`. Every other rules module below is an application of this premise.

@.claude/rules/clean-architecture.md

### Process — how changes get proposed, planned, and landed
@.claude/rules/workflow.md
@.claude/rules/quality-bar.md
@.claude/rules/git-workflow.md
@.claude/rules/documentation.md

### Code — style, tests, failure handling
@.claude/rules/code-style.md
@.claude/rules/testing.md
@.claude/rules/error-handling.md

### Data & interfaces — schema, modeling, API boundaries
@.claude/rules/api-design.md
@.claude/rules/database.md
@.claude/rules/data-modeling.md

### Interface — front-end engineering and visual language
@.claude/rules/frontend.md
@.claude/rules/design-system.md

### AI features — model calls, prompts, enrichment
@.claude/rules/ai-features.md

## Project Knowledge

Team-shared context lives in `docs/claude/` and is committed to git. **Read these when relevant:**

- `docs/claude/roadmap.md` — **the overall plan** — initiatives (Now/Next/Later); read with in-progress.md
- `docs/claude/in-progress.md` — **start here** — the ordered queue of what's next, with pointers to plan docs
- `docs/claude/completed-features.md` — what's already been built
- `docs/claude/worklog.md` — running change log; append one line in the same commit as your change
- `docs/claude/architecture.md` — key decisions and why (indexes the ADRs under `adr/` and `docs/adr/`)
- `docs/claude/infrastructure.md` — deploy pipeline, hosting, data stores, jobs
- `docs/claude/key-patterns.md` — dev patterns, gotchas, testing conventions

Personal preferences and per-user workflow rules stay in local `~/.claude/` memory, not here.

## Project-Specific Rules

- Change-approval protocol: **relaxed** — proceed on small, obviously-scoped edits; describe-first for anything structural (see `.claude/rules/workflow.md`).
- All AI routes through Plexo (`@joeybuilt/plexo-sdk`); never pin a provider/model locally — `pnpm conformance` fails the build on drift.
- `PlexoConnectionStatus` lives in the dashboard layout — never add it to individual pages.
- This Next.js (16) has breaking changes vs training data — check `node_modules/next/dist/docs/` before writing Next-specific code.
