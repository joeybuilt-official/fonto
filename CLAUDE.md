# Fonto — Claude Code Guidelines

## Project Overview

Fonto is an AI-classified digital asset manager for photos, documents, and scans, with unified search and self-hosted storage. TODO: confirm.

**Core pillars**: universal asset intake; trustworthy AI enrichment; unified search and metadata; user-owned, reversible storage workflows.

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

## How We Work Together

`AGENTS.md` is user-owned and authoritative. Read it first; its rules win over this kit. It is also the provider-neutral hub for every other tool (Cursor, Copilot, Codex, Windsurf, Cline, aider, Gemini), so it loads into every agent's context via the import below. Before writing Next.js code, read the relevant guide in `node_modules/next/dist/docs/`.

The rules below are not suggestions. When a rule and a shortcut conflict, the rule wins — or raise the conflict explicitly and let me decide. Read the module that governs what you're touching before you touch it.

@AGENTS.md

### Architecture - the premise everything else inherits from

Clean Architecture is the target for new code: business rules stay inward, while the database, web framework, UI, queues, and vendor APIs remain replaceable details at the edge.

@.claude/rules/clean-architecture.md

### Process - how changes get proposed, planned, and landed
@.claude/rules/workflow.md
@.claude/rules/quality-bar.md
@.claude/rules/git-workflow.md
@.claude/rules/documentation.md

### Code - style, tests, failure handling
@.claude/rules/code-style.md
@.claude/rules/testing.md
@.claude/rules/error-handling.md

### Data & interfaces - schema, modeling, API boundaries
@.claude/rules/api-design.md
@.claude/rules/database.md
@.claude/rules/data-modeling.md

### Interface - front-end engineering and visual language
@.claude/rules/frontend.md
@.claude/rules/design-system.md

### AI features - model calls and enrichment
@.claude/rules/ai-features.md

## Project Knowledge

Team-shared context lives in `docs/claude/` and is committed to git. Read these when relevant:

- `docs/claude/roadmap.md` - the overall plan; initiatives in Now/Next/Later; read with in-progress.md
- `docs/claude/in-progress.md` - ordered active work; start here
- `docs/claude/worklog.md` - running change log; append one line in the same commit as your change
- `docs/claude/completed-features.md` - shipped work and archived plans
- `docs/claude/architecture.md` - Fonto system shape, boundaries, and decisions
- `docs/claude/infrastructure.md` - runtime, deployment evidence, stores, and jobs
- `docs/claude/key-patterns.md` - verified conventions and gotchas
- `docs/claude/<area>/` - area-specific plans and research

## Project-Specific Rules

- AI credentials are encrypted at rest through `lib/crypto/secret-box.ts`; never store or log a plaintext key. AI connection settings live in Settings → Integrations.
- Every `/api/v1` route change updates `lib/openapi/routes.ts` and passes the OpenAPI registration check.
- Database changes use generated Drizzle migrations. Never use `pnpm db:push` against a live database.
- Preserve unrelated worktree changes. This setup task never changes application source, tests, manifests, CI, schemas, or existing docs outside `docs/claude/`.
