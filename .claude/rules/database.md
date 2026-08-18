# Database & Migrations

> Applies to Fonto's PostgreSQL schema and Drizzle migration history.

## Boundary

- The database is a Frameworks & Drivers detail. Repository/query adapters stay outside pure rules.
- The schema source is `lib/db/schema.ts`; migrations live in `drizzle/migrations/`.
- Use `db` and `schema` from `lib/db/`. Never pass Drizzle rows or query builders into inward logic.

## Schema changes

- Make every schema change through a migration. Do not edit a live database with a GUI, console, or ad-hoc `ALTER`.
- Change `lib/db/schema.ts` first, then generate with `pnpm db:generate`.
- Review generated SQL in `drizzle/migrations/`; do not author a migration from scratch.
- Migrations are forward-only. Never edit or delete one that may be merged or applied; fix it with a new migration.
- Treat destructive SQL, type narrowing, and data rewrites as operator-gated changes.

## Apply and verify

- Apply with `pnpm db:migrate`, the repository's forward migration command. Never use `pnpm db:push` against a live database.
- Never run reset, force, accept-data-loss, or schema-push variants to unblock a migration.
- After an operator applies a migration, verify the expected object in PostgreSQL's catalog or with a targeted query. Do not infer success from CLI output alone.

## Data writes

- Validate at the boundary before writing.
- Prefer parameterized Drizzle queries over interpolated SQL.
- Update rows with `UPDATE`; do not delete and reinsert user-visible data.
- Keep backfills idempotent, bounded, and resumable.

## Verification reality

No CI workflow or migration-integrity checker is present in this repository. Migration generation, SQL review, apply, and catalog verification are manual gates until CI adds them.
