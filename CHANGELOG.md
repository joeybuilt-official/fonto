# Changelog

Notable changes to Fonto. Newest first.

This file is the worklog target for `scripts/check-docs.sh`: a commit that
changes code must update this file in the same commit.

## Unreleased

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
