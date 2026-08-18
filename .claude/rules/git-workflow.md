# Git Workflow

> Applies to Fonto's git history. `AGENTS.md` is user-owned and wins if a rule differs.

## Commits

- Use conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, or `docs:`.
- Keep one logical change per commit; do not mix a domain change with infrastructure work.
- Do not create commits unless the user asks. This setup adaptation is intentionally uncommitted.

## Gates

Before committing, run the relevant full checks: `pnpm typecheck`, `pnpm lint`, `pnpm test:e2e`, and `pnpm tsx scripts/check-openapi-coverage.ts --strict`. Run `pnpm --filter @joeybuilt/fonto-sdk test` when SDK files changed. Never claim a green gate that was not run.

## Branch and landing policy

- `origin/HEAD` is `main`.
- `AGENTS.md` currently requires a single `main` branch, direct landing on `main`, archiving `archive/*` before branch deletion, and never losing work. Follow that policy instead of a generic PR workflow.
- Preserve unrelated dirty changes. Inspect `git status` and `git diff` before staging anything.
