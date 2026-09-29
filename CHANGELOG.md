# Changelog

Notable changes to Fonto. Newest first.

This file is the worklog target for `scripts/check-docs.sh`: a commit that
changes code must update this file in the same commit.

## Unreleased

### Changed — retire the last Codemagic references; signing secrets renamed

Codemagic was already gone from the build path — `.pushd.yaml` has been the CI
plane for a while — but stale names remained: `.pushd.yaml`, `mobile/CI.md`,
`mobile/README.md` and `.claude/agents/fonto-mobile.md` all still pointed at
`codemagic.yaml`, and the signing env vars kept their Codemagic-derived `CM_*`
names even though pushd reads them. This removes every remaining reference and
moves the secrets onto pushd's own android-schema names.

Renames, applied end to end (`.pushd.yaml`, `mobile/android/app/build.gradle`):

| was | is |
|---|---|
| `CM_KEYSTORE_BASE64` | `ANDROID_KEYSTORE_BASE64` |
| `CM_STORE_PASSWORD` | `ANDROID_KEYSTORE_PASSWORD` |
| `CM_KEY_ALIAS` | `ANDROID_KEY_ALIAS` |
| `CM_KEY_PASSWORD` | `ANDROID_KEY_PASSWORD` |
| `CM_KEYSTORE_PATH` | `ANDROID_KEYSTORE_PATH` |

The four `ANDROID_*` secrets are the names pushd's android schema already
expects (`ANDROID_KEYSTORE_SECRETS` in `packages/build/src/schema/android.ts`),
so a hand-written `secrets:` list and the auto-generated signing commands now
agree — previously the hand-written list drove the `CM_*` path while pushd's own
generator would have injected `ANDROID_*`. Both entries (`android-release` on
`v*`, `android-publish` on `release-v*`) keep their triggers unchanged.

`mobile/CI.md` is rewritten against pushd: the two entry names and their tag
gates, the Docker/Flutter builder image, keystore rotation through the pushd
project secret store instead of Codemagic's UI, and a triage table keyed on the
new names. `mobile/README.md` drops the "Codemagic or GitHub macOS runner" lines
to "GitHub macOS runner" (Android already builds on pushd). The `fonto-mobile`
agent's scope line names `.pushd.yaml` rather than the removed `codemagic.yaml`,
and its "builds run in Codemagic" rule now says pushd.

Deployment side: the pushd project store for `fonto` must carry the four
`ANDROID_*` keys before the next `v*` tag, or the release build falls back to
debug signing.

### Changed — README rewritten and reconciled with the working install path

PR #3 rewrote `README.md` (1207 → 309 lines) from a cut at `cfc85d29`, before
the install-path fix landed on `main`. Merging the two left `README.md` as the
only conflicting file; it is resolved by hand against the merged tree, keeping
the rewrite's structure and honest tone while documenting the path that
actually works.

The Quick start now leads with `docker compose up -d` and the six `${VAR:?}`
values compose refuses to start without, and the bare-host path uses
`pnpm db:setup` — not `pnpm db:migrate` — with the three reasons
`drizzle-kit migrate` cannot drive this series stated inline. The compose
profiles, `Dockerfile.migrate`, `drizzle/baseline/` and
`docs/self-hosting.md` are all documented, and `pnpm db:push` is named as the
banned destructive command `AGENTS.md` already forbids.

Claims the rewrite carried from the pre-fix tree are corrected: the
`docker-compose.yml` and the migration runner now exist (it said neither did),
`REDIS_URL` defaults to loopback rather than a container DNS name (those two
literals were also the branch's only `scan-infra` R5 hits), there are five
Dockerfiles rather than four, CI runs on GitHub-hosted `ubuntu-latest` with a
`pull_request` trigger and does run `pnpm test`, and `PASSKEY_RP_ID` falls back
to `localhost` rather than to a production domain. Counts were re-verified
against the merged tree: 137 `/api/v1` route handlers, 62 numbered migrations
plus 2 baselines, 18 non-mobile `*.test.ts` (15 matched by `vitest.config.ts`),
136 allowlisted untested handlers, 11 middleware redirects, 6 unconditional and
6 opt-in repeatable jobs.

### Changed — `verify` moved to GitHub-hosted runners and gained a PR gate

`verify.yml` ran on `[self-hosted, hive]` with `push` + `workflow_dispatch`
only. It now runs on `ubuntu-latest` and also on `pull_request`, so a PR reports
a `verify` check that can be made **required** — previously fonto had no check
that ran on PRs at all, and an open PR carried zero check runs.

Two reasons the self-hosted pin no longer holds:

- **The reason it moved there is gone.** The header recorded that hosted jobs
  were rejected in Aug 2026 because the Free plan had burned its 2,000 included
  minutes. That allowance meters *private* repos; for public repos standard
  hosted runners are free and unlimited. fonto is public now.
- **Hosted is the safer runner for a public repo, and also the bigger one.**
  Public-repo `ubuntu-latest` is 4 vCPU / 16 GB, versus the 8 GiB the hive
  runners are capped at, so the `--max-old-space-size=6144` heap has more
  headroom than it did on self-hosted. And for a `pull_request` event GitHub
  takes the workflow from the PR's *merge commit*, so the fork controls the job
  body — acceptable on an ephemeral VM, unacceptable on a runner where the
  `docker`-labelled peer is uid=0 with `/var/run/docker.sock` mounted.

The header's INVARIANT block now records that this job must stay hosted, and why
it must never grow a `secrets.*` dependency (fork PRs receive none, so one would
fail every outside contribution). Steps are unchanged — 13 of them, byte-identical;
only the header, triggers, and `runs-on` differ. nexalog's `verify.yml` is the
proven precedent for the same trigger set on the same runner.

### Fixed — CI could not run at all

Two independent things kept `verify.yml` from ever executing, both discovered
only after #2 merged:

- **The org runner group blocked this repository.** `joeybuilt-official`'s
  `Default` self-hosted runner group had `allows_public_repositories: false`,
  so *no* public repo could schedule a job on `hive-ci-1` / `hive-ci-4`. Runs
  queued indefinitely with no annotation explaining why (Fonto and Plexo both
  had jobs stuck since 03:17 while private repos ran fine). Flipped to `true`
  after auditing all 8 workflows in both public repos: **zero** of them run a
  self-hosted job on a `pull_request` or `pull_request_target` trigger, so an
  untrusted fork PR cannot reach a runner. The only PR-triggered workflow
  (`plexo/changelog-check.yml`) uses GitHub-hosted runners.
- **`pnpm/action-setup@v4` rejected the pnpm pin #2 added.** The workflow
  already passed `version: 10`, and action-setup v4 errors out when a version
  is *also* present in `package.json`'s `packageManager` ("Multiple versions
  of pnpm specified"), failing at step 3 in ~11 s before any real work.
  Removed the redundant `version:` input so the action reads the pinned
  `packageManager` — the documented v4 pattern.

`pnpm build` was **not** broken, despite an earlier report that it was: that
diagnosis came from running bare `next build`, which defaults to Turbopack in
Next 16 and rejects this repo's `webpack` externals block. The real script is
`next build --webpack`; it passes (exit 0).

### Fixed — the infra scanner failed on its own tree

`pnpm scan:infra` reported 12 hits on the tree #2 shipped, so the gate #2 added
could never have passed. Because no public-repo CI had ever run (above), nothing
caught it. Three causes:

- **R2 was too broad.** It matched `/data/fonto-media`, but that is a container
  mount point *inside a named volume that this repo's own `docker-compose.yml`
  defines* — the app's internal layout that every self-hoster gets, not the
  deploy box's. Narrowed R2 back to the actual leak class (`/data/appdata`,
  `/data/_secrets`, `/data/backups`, `/mnt/user/`, `/opt/app/`).
- **`docker-compose.example.env` was missing from `ALLOW_R5_PATHS`** despite
  documenting each service's internal DNS name (`redis://valkey:6379`,
  `http://minio:9000`) as the value a compose deployer wants.
- **`lib/r2PathStyle.test.ts` was missing too.** Path-style resolution is
  decided *by* the endpoint host — minio needs it, R2/S3 must not — so those
  hostnames are the subject under test, not a leak.

Both additions are **rule-scoped to R5** (that array is only consulted for
`R5-internal-dns`), so they cannot silence another rule in those files. Proved
by negative control: injecting `https://myfonto.com` into
`docker-compose.example.env` still fires R1 *and* R6, and injecting
`ssh root@prod-box` into the test file still fires R3. `--self-test` still
detects all 8 rules (it seeds R2 via `/data/appdata`, so narrowing the pattern
did not blind it).

### Fixed — database setup on a fresh install

`pnpm db:migrate` could not work on this repository, for three independent
reasons, and it failed *silently* (exit 0, nothing applied):

- There is no `drizzle/meta/_journal.json`, so Drizzle's `readMigrationFiles()`
  threw before applying anything. A fresh clone therefore came up with an empty
  database while the command reported success.
- `drizzle/migrations/` starts at `0001_share_links.sql`, and `0002` immediately
  alters `fonto.assets` — but no numbered migration ever creates the base
  `fonto` tables. They had been created out-of-band.
- Drizzle wraps every pending migration in one transaction, and migrations
  `0037` and `0058` use `CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses
  inside a transaction block.

Added `drizzle/baseline/` (base `fonto` tables + the Better Auth `auth` schema)
and `scripts/db-apply.sh`, which drives `psql` directly and is now the supported
path: `pnpm db:setup`, with `--dry-run` and `--adopt` modes. Verified end to end
against a fresh PostgreSQL 16 + pgvector database: 64/64 files applied, 48
`fonto` tables, 4 `auth` tables, no invalid indexes.

### Fixed — the `auth` schema was never created

`lib/auth.ts` opens its pool with `search_path=auth`, but nothing in the repo
created that schema or the Better Auth tables, and Better Auth's `$context` does
not create tables on its own. A fresh install could not sign in even with the
`fonto` schema present. The baseline DDL is dumped from Better Auth 1.6.9
itself rather than hand-written (columns, indexes and foreign keys verified
against the library's own generated schema).

### Fixed — `--adopt` could stamp an empty database

`db-apply.sh --adopt` recorded every migration as applied without checking that
the schema existed, so pointing it at an empty database produced a green log and
an install that could never serve a request (every later run would skip
everything). It now refuses unless `fonto.assets` or `auth."user"` is present.

### Added — self-hosting install path

- `docker-compose.yml` — Postgres/pgvector, Valkey, MinIO, web, worker, a
  one-shot `migrate` service the app waits on, and opt-in profiles for
  `bullboard`, `backup`, `observability`, `selfhosted` (Caddy TLS) and
  `autoscaler`. No production hostname, host path or credential is baked in.
- `Dockerfile.migrate` — a minimal image carrying only `db-apply.sh` and the
  SQL, so a migration run cannot import application code.
- `docker-compose.example.env`, `docs/self-hosting.md`, and an `ops/caddy/`
  Caddyfile.
- `.env.example` completed: every variable the code reads is now documented,
  with the real defaults read off the source rather than guessed.

### Added — infrastructure-identifier guard

`scripts/scan-infra-identifiers.sh` (`pnpm scan:infra`) blocks committed
production hostnames, deploy-box paths, container DNS names, internal database
names and routable IPs, with `--self-test` planting one canary per rule to prove
the scanner detects rather than passing vacuously. Development domains,
documentation IP ranges (RFC 5737) and the localhost defaults are deliberately
not findings.

### Changed — production identifiers removed

Every reference to the maintainers' own domains, host paths and internal service
names was replaced with an environment variable or a documented placeholder
(`<YOUR_APP_ORIGIN>`, `<host-path>`). Two of these were also documentation bugs:
the README claimed `REDIS_URL` defaulted to a container DNS name (it defaults to
`localhost`; a container name cannot resolve on a bare host) and that
`PLEXO_VISION_URL` had a default (it throws when unset, by design).

### Changed — CI

`pnpm test` now runs in `verify.yml` before the build, so a unit-test failure
reports in seconds instead of surfacing as a failed 6 GiB `next build`.
