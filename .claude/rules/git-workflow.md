# Git Workflow

> Applies to Fonto's git history. `AGENTS.md` is user-owned and wins if a rule differs.

## Commits

- Use conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, or `docs:`.
- Keep one logical change per commit; do not mix a domain change with infrastructure work.
- Do not create commits unless the user asks. This setup adaptation is intentionally uncommitted.

## Gates

Before committing, run the relevant full checks: `pnpm typecheck`, `pnpm lint`, `pnpm test:e2e`, `pnpm tsx scripts/check-openapi-coverage.ts --strict`, and `pnpm tsx scripts/check-endpoint-tests.ts`. Run `pnpm --filter @joeybuilt/fonto-sdk test` when SDK files changed. Never claim a green gate that was not run.

## Branch and landing policy

- `origin/HEAD` is `main`.
- Work lands on task branches (`task/<slug>`) that merge into `main`; changes are preserved as reviewable diffs. Preserve unrelated dirty changes. Inspect `git status` and `git diff` before staging anything.

## Repo hygiene & credentials

- Verify commit identity before the first commit in a fresh clone: confirm `git config user.name` and `git config user.email` match what this repo declares it commits under; set them repo-locally (`git config user.email …`, never `--global`) if they do not.
- Never put a credential in a remote URL and never commit a secret. Keep git auth in a credential helper so the remote stays `https://github.com/<owner>/<repo>.git`. If a token was ever embedded in a URL, rotate it.
- The `.claude/settings.json` deny-list binds only Claude Code. The tool-agnostic guardrail is server-side: branch protection on `main` plus required status checks (`scripts/templates/ci-verify.yml`). Until those are enabled, the cross-tool `MUST NOT` list in `AGENTS.md` is advisory prose.
- Remind the user to commit at the end of each feature or milestone — uncommitted work is the one kind a bad `git checkout` can delete outright.
