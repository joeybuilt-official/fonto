# Self-Hosting Fonto

This is the deployer's guide. `docker compose up -d` is the supported install
path; everything below is what that command assumes and what to do when the
defaults do not fit.

- [Quick start](#quick-start)
- [What you must supply](#what-you-must-supply)
- [The database schema is applied by `migrate`](#the-database-schema-is-applied-by-migrate)
- [Object storage must be reachable by the browser](#object-storage-must-be-reachable-by-the-browser)
- [Serving Fonto to other machines](#serving-fonto-to-other-machines)
- [Optional profiles](#optional-profiles)
- [Upgrading](#upgrading)
- [Where the production-origin values went](#where-the-production-origin-values-went)

## Quick start

```bash
git clone https://github.com/joeybuilt-official/fonto.git
cd fonto
cp docker-compose.example.env .env
```

Edit `.env` and fill in every value marked required (see the next section —
there are no usable production defaults), then:

```bash
docker compose up -d
docker compose logs -f fonto
```

Fonto listens on `http://localhost:3500` by default.

## What you must supply

Nothing in `docker-compose.yml` has a working default for a real deployment.
Compose refuses to start — rather than booting something subtly wrong — when a
required value is missing, which is why the variables below use the `${VAR:?}`
form.

| Variable | What it is | How to make one |
|---|---|---|
| `POSTGRES_PASSWORD` | Database password | `openssl rand -hex 24` |
| `AUTH_SECRET` | Session/token signing secret | `openssl rand -hex 32` |
| `SHARE_LINK_IP_SALT` | Salt for hashing visitor IPs on share links | `openssl rand -hex 32` |
| `MINIO_ROOT_PASSWORD` | Object-store password (`= R2_SECRET_ACCESS_KEY`) | `openssl rand -hex 24` |
| `REDIS_PASSWORD` | Queue/cache password | `openssl rand -hex 24` |
| `NEXT_PUBLIC_APP_URL` | Your public origin | e.g. `http://localhost:3500` |

Two of these deserve emphasis:

**`SHARE_LINK_IP_SALT` is not optional.** `lib/share-links/ip-hash.ts` throws
without it, because the constant fallback is committed in a public repository —
every instance that did not override it would hash visitor IPs identically.

**`NEXT_PUBLIC_APP_URL` is a build arg, not just a runtime variable.** Next.js
inlines `NEXT_PUBLIC_*` at compile time, so changing it requires
`docker compose build fonto`, not a restart. The Dockerfile deliberately has no
production default: omit it and you get `http://localhost:3500`, which makes a
forgotten value fail visibly instead of silently wiring your instance to
somebody else's domain.

## The database schema is applied by `migrate`

The one-shot `migrate` service creates everything the app needs, and `fonto` +
`fonto-worker` wait for it to exit successfully before they start.

It applies, in order:

1. `drizzle/baseline/0000_auth_baseline.sql` — the Better Auth `auth` schema
   (`user`, `session`, `account`, `verification`).
2. `drizzle/baseline/0000_fonto_baseline.sql` — the original `fonto` tables.
3. Every file in `drizzle/migrations/` in strict filename order.

Applied work is recorded in `fonto.__db_apply_log`, so a re-run skips what is
already done.

### Why not `pnpm db:migrate`

`drizzle-kit migrate` **cannot** work on this repository. It is not a bug you can
work around with the right flag — there are three independent reasons:

1. **There is no `drizzle/meta/_journal.json`.** Drizzle's `readMigrationFiles()`
   throws without it, so the documented `pnpm db:migrate` applies *nothing* on a
   fresh clone and still exits 0. That silent success is the worst possible
   failure mode for an install step.
2. **There is no baseline in the numbered series.** `drizzle/migrations/` starts
   at `0001_share_links.sql`, and `0002` immediately runs
   `ALTER TABLE fonto.assets`. No numbered migration ever creates `fonto.assets`
   or its ten sibling base tables — they were created out-of-band before the
   series began. A journal alone would not fix this.
3. **Drizzle wraps every migration in one transaction**, and migrations `0037`
   and `0058` use `CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses inside a
   transaction block.

`scripts/db-apply.sh` drives `psql` directly and therefore has none of these
constraints. It is the supported path:

```bash
pnpm db:setup            # == bash scripts/db-apply.sh
pnpm db:setup:dry-run    # print the plan, touch nothing
pnpm db:setup:adopt      # record state without executing (existing databases)
```

### Adopting an existing database

If you already have a Fonto database that was migrated by hand, `--adopt`
records the current migration set as applied — without running any SQL — so
future runs behave. It matches each migration by the SHA-256 of its file
contents, so do not reword an applied migration file afterwards: the hash is
the identity the database recorded.

## Object storage must be reachable by the browser

This is the single most common self-hosting mistake, and it fails in a
confusing way (uploads die in the browser's network layer, while the server logs
look fine).

There is **one** endpoint variable, `R2_ENDPOINT`, and it is used twice:

- **server-side**, by the worker and the app, to PUT/GET objects; and
- **in the browser**, because presigned URLs handed to the client are built from
  it (`lib/storage/r2-backend.ts` → `getSignedUrl`).

So `R2_ENDPOINT` must resolve from the user's browser, not merely from inside
the compose network. The default `http://minio:9000` therefore only works for a
single-host install reached on localhost.

For any browser on another machine, publish MinIO and point the variable at a
browser-reachable address:

```bash
# .env
R2_ENDPOINT=http://<host-ip-or-domain>:9000
```

…and uncomment the `minio` `ports:` block in `docker-compose.yml`.

The `minio-init` service also applies a bucket CORS policy (the equivalent of
`docs/r2-cors.json`). Without it the browser blocks the presigned PUT.

## Serving Fonto to other machines

Three things must agree on one origin:

1. `NEXT_PUBLIC_APP_URL` in `.env` — then **rebuild** (`docker compose build fonto`).
2. `BETTER_AUTH_URL` (defaults to `NEXT_PUBLIC_APP_URL`).
3. `PASSKEY_ORIGIN` (defaults to `NEXT_PUBLIC_APP_URL`).

For TLS, enable the `selfhosted` profile. Caddy obtains and renews certificates
automatically:

```bash
# .env
PUBLIC_DOMAIN=fonto.example.com
NEXT_PUBLIC_APP_URL=https://fonto.example.com

docker compose --profile selfhosted up -d
```

Prerequisites: `PUBLIC_DOMAIN` resolves to the host, and ports 80/443 are
reachable from the internet (Let's Encrypt validation needs one of them).

> **Passkeys:** `PASSKEY_RP_ID` is derived from the origin when unset. It is
> baked into every registered credential, so changing domains later forces all
> users to re-register. Set it deliberately before your first user.

## Optional profiles

The default `up` stays small. Opt in to the rest:

| Profile | Services | Notes |
|---|---|---|
| `bullboard` | Queue admin UI | Loopback-only (`127.0.0.1:3300`). Refuses to boot without basic-auth credentials. |
| `backup` | `postgres-backup` | Plain-text `pg_dump` on an interval. A floor, not a DR strategy — use `scripts/dr/` for encrypted offsite backups. |
| `observability` | Prometheus, Alertmanager, Grafana | See `ops/README.md`. |
| `selfhosted` | Caddy | Automatic TLS for a public host. |
| `autoscaler` | Worker autoscaler | Mounts the Docker socket (**root-equivalent**). Starts in dry-run; read the logs before disabling that. |

```bash
docker compose --profile selfhosted --profile bullboard up -d
```

## Upgrading

```bash
git pull
docker compose build          # rebuilds fonto (NEXT_PUBLIC_APP_URL is inlined)
docker compose up -d          # migrate runs first, then the app
```

`migrate` is idempotent: it applies only what `fonto.__db_apply_log` does not
already record.

## Where the production-origin values went

Earlier revisions of this repository hard-coded the maintainers' own domain
names, host paths and internal service names. Those are gone: every one is now
either an environment variable you supply or a documented placeholder
(`<YOUR_APP_ORIGIN>`, `<host-path>`). Nothing about the upstream deployment is
required to run your own.

`scripts/scan-infra-identifiers.sh` enforces this in CI (`pnpm scan:infra`),
with `--self-test` proving the rules still detect a planted violation rather
than passing vacuously.
