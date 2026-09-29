<div align="center">
  <h1>Fonto</h1>
  <p><strong>Your AI-classified digital asset manager.</strong></p>
  <p>Photos, documents, scans, RAW files and video in one library — auto-tagged, OCR'd, deduped by perceptual hash, and searchable across every file type. Self-host on your own S3-compatible bucket and Postgres.</p>

  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
</div>

Fonto ingests a large mixed media library and derives the organization for you: dates, places, faces, duplicates, variants and classifications are computed by a background pipeline instead of typed in by hand. Everything stays in your own Postgres and your own object storage.

## Table of contents

- [What it does](#what-it-does)
- [What you need to run it](#what-you-need-to-run-it)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [AI enrichment is optional](#ai-enrichment-is-optional)
- [Features](#features)
- [Architecture](#architecture)
- [API](#api)
- [Background jobs](#background-jobs)
- [CLI and mobile](#cli-and-mobile)
- [Development](#development)
- [Current limitations](#current-limitations)
- [Contributing](#contributing)
- [License](#license)

## What it does

Upload a file and Fonto:

1. Stores it in S3-compatible object storage (Cloudflare R2, or the MinIO the compose stack brings up) and writes an `assets` row in Postgres.
2. Queues it for processing: EXIF and GPS extraction, thumbnails and responsive derivatives, perceptual hash and dominant palette, RAW/HEIC decode, video probe plus HLS ladder and sprite sheet.
3. Enriches it if an AI tier is configured: classification, captioning, OCR text, CLIP embeddings for semantic search, face detection and clustering.
4. Reconciles the capture date from every piece of evidence it can find (EXIF, filename, sidecar, image content) and proposes a correction rather than overwriting your data.
5. Surfaces it in a single Library grid/timeline with filters, plus People, Map, Collections, Smart Collections, Stacks, Shoots, Duplicates, Memories and Imports views.

## What you need to run it

| Requirement | Notes |
|---|---|
| Docker + Compose | The supported install path — `docker-compose.yml` brings up Postgres/pgvector, Valkey and MinIO for you |
| Node 22 + pnpm 10 | Bare-host development only. Pinned by `package.json` (`engines.node: >=22`, `packageManager: pnpm@10.4.1`), `Dockerfile` (`node:22-alpine`) and `.github/workflows/verify.yml` |
| PostgreSQL with `pgvector` | Migration `0017_pgvector_setup.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` and adds `fonto.assets.clip_vec vector(512)`. The compose file uses `pgvector/pgvector:pg16` |
| A `psql` client, on the bare-host path | `scripts/db-apply.sh` drives `psql` directly (`apt-get install postgresql-client`, or set `PSQL_BIN`) |
| Redis or Valkey | BullMQ queues. `REDIS_URL` defaults to `redis://localhost:6379` in `lib/queue/connection.ts`; the compose stack overrides it to its own Valkey service |
| S3-compatible object storage | Cloudflare R2 recommended; the bundled MinIO works for a single-host install |
| Worker host tooling | `libheif`, `libraw`, `exiftool`, `ffmpeg`, `imagemagick`, `poppler-utils` — installed by `Dockerfile.worker`. A bare host without them degrades **silently**: HEIC/RAW/PDF/video assets record a thumbnail failure instead of crashing |

## Quick start

**Docker Compose (recommended):**

```bash
git clone https://github.com/joeybuilt-official/fonto.git
cd fonto
cp docker-compose.example.env .env    # then fill in every required value
docker compose up -d
docker compose logs -f fonto
```

Open [http://localhost:3500](http://localhost:3500). Compose refuses to start until you have supplied every value it interpolates as `${VAR:?}` — nothing has a usable production default:

| Variable | What it is | How to make one |
|---|---|---|
| `POSTGRES_PASSWORD` | Database password | `openssl rand -hex 24` |
| `AUTH_SECRET` | Session/token signing secret | `openssl rand -hex 32` |
| `SHARE_LINK_IP_SALT` | Salt for hashing share-link visitor IPs | `openssl rand -hex 32` |
| `MINIO_ROOT_PASSWORD` | Object-store password (`= R2_SECRET_ACCESS_KEY`) | `openssl rand -hex 24` |
| `REDIS_PASSWORD` | Queue/cache password | `openssl rand -hex 24` |
| `NEXT_PUBLIC_APP_URL` | Your public origin — a **build arg**, so change it and re-run `docker compose build fonto` | e.g. `http://localhost:3500` |

The one-shot `migrate` service creates the schema before `fonto` and `fonto-worker` start, and re-running it is idempotent. Profiles, upgrades, TLS via the `selfhosted` Caddy profile, and the browser-reachability trap on `R2_ENDPOINT` are all in **[docs/self-hosting.md](docs/self-hosting.md)**.

**Bare host (development):**

```bash
git clone https://github.com/joeybuilt-official/fonto.git
cd fonto
cp .env.example .env.local
pnpm install
set -a; . ./.env.local; set +a   # the worker is bare Node — it does NOT load .env.local
pnpm db:setup                    # NOT `pnpm db:migrate` — see below
pnpm dev                         # web app → http://localhost:3500
pnpm tsx worker/index.ts         # processing worker (separate terminal)
```

Fill in `.env.local` first: `DATABASE_URL`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `SHARE_LINK_IP_SALT` and the `R2_*` storage keys. See [Configuration](#configuration).

> **The worker does not read `.env.local`.** Next.js loads `.env.local` for `pnpm dev` only; `worker/index.ts` is a bare Node process with no dotenv anywhere in its import chain, so it throws `DATABASE_URL environment variable is not set` on the first query (`lib/db/index.ts`) and falls back to `redis://localhost:6379`. Export the variables in the worker's shell as above, or run the worker in Docker with an env file.

> **Use `pnpm db:setup`, not `pnpm db:migrate`.** `drizzle-kit migrate` cannot work on this repository, and it used to fail *silently* — exiting 0 having applied nothing. Three independent reasons: there is no `drizzle/meta/_journal.json` for drizzle's `readMigrationFiles()` to read; the numbered series has no baseline (`0002` runs `ALTER TABLE fonto.assets`, a table no migration ever creates); and drizzle wraps the whole series in one transaction, while `0037` and `0058` use `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside a transaction block. `pnpm db:migrate` is now a wrapper (`scripts/db-migrate-refuses.sh`) that exits 1 and points here instead.
>
> `pnpm db:setup` (`scripts/db-apply.sh`) drives `psql` with no surrounding transaction, so all three constraints disappear. It creates the `fonto` **and** `auth` schemas itself, applies `drizzle/baseline/0000_auth_baseline.sql` and `drizzle/baseline/0000_fonto_baseline.sql` (the 4 Better Auth tables and the 11 original `fonto` tables), then all 62 files in `drizzle/migrations/` in strict filename order — 64 files total — recording each in `fonto.__db_apply_log` by the SHA-256 of its contents. That hash is the file's identity, so never reword an applied migration afterwards.
>
> ```bash
> pnpm db:setup:dry-run    # print the plan, touch nothing
> pnpm db:setup:adopt      # record an already-migrated database without running SQL
> ```
>
> `--adopt` refuses a database that has neither `fonto.assets` nor `auth."user"`, so it cannot stamp all 64 files as applied against an empty schema and leave an unrepairable install. Full rationale: [docs/self-hosting.md](docs/self-hosting.md#why-not-pnpm-dbmigrate).

`pnpm db:push` (`drizzle-kit push`) is banned outright by `AGENTS.md` as a destructive command — never run it against a real database.

The first account you create bootstraps the instance. **Registration is invite-only after that** (`lib/auth.ts`) — set `FONTO_ALLOW_OPEN_SIGNUP=true` to open it, or invite people from Settings ▸ Members.

Fetch the geocoding dataset if you want real place names on the map (the repo ships a 51-line placeholder):

```bash
pnpm tsx scripts/fetch-geonames.ts
```

### Containers

`docker-compose.yml` runs `postgres`, `valkey`, `minio`, `minio-init` (one-shot bucket + CORS policy), `migrate` (one-shot schema), `fonto` (web) and `fonto-worker`, plus five opt-in profiles so the default `up` stays small:

| Profile | Services | Notes |
|---|---|---|
| `bullboard` | Queue admin UI | Loopback-only (`127.0.0.1:3300`); refuses to boot without `BULL_BOARD_BASIC_AUTH_USER` / `_PASS` |
| `backup` | `postgres-backup` | Plain-text `pg_dump` on an interval — a floor, not a DR strategy; `scripts/dr/` holds the encrypted path |
| `observability` | Prometheus, Alertmanager, Grafana | See `ops/README.md` |
| `selfhosted` | Caddy | Automatic TLS for a public host (`ops/caddy/Caddyfile`) |
| `autoscaler` | Worker autoscaler | Mounts the Docker socket (**root-equivalent**); starts in dry-run |

```bash
docker compose --profile selfhosted --profile bullboard up -d
```

Postgres, Valkey and MinIO publish **no** ports by default — they are reachable only on the internal compose network. To build the images by hand instead:

```bash
docker build -f Dockerfile -t fonto:dev .                     # web, EXPOSE 3500
docker build -f Dockerfile.worker -t fonto-worker:dev .         # processing worker + media toolchain
docker build -f Dockerfile.bullboard -t fonto-bullboard:dev .   # queue UI, EXPOSE 3300
docker build -f Dockerfile.migrate -t fonto-migrate:dev .       # psql + SQL only, no node_modules
docker build -f ops/autoscaler/Dockerfile -t fonto-autoscaler:dev .
```

A bare `docker run` outside the stack cannot resolve the stack's service DNS names. Either point `REDIS_URL` / `DATABASE_URL` at an address that resolves from the container, or join the stack's network with `--network <stack-net>`.

## Configuration

`.env.example` is the reference and marks each variable `[R]` required or `[O]` optional. It documents every variable the code reads via `process.env.X` — 150 of them — and `scripts/check-env-example.sh` runs in CI to stop it drifting.

Required at boot:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection for Fonto's tables (pgvector required) |
| `AUTH_DATABASE_URL` | Better Auth tables in the `auth` schema; falls back to `DATABASE_URL` |
| `AUTH_SECRET` | Session signing (`openssl rand -hex 32`) |
| `NEXT_PUBLIC_APP_URL` | Public origin — OAuth callbacks, cookies, presigned upload hosts |
| `SHARE_LINK_IP_SALT` | `lib/share-links/ip-hash.ts` **throws in production** without it; the dev fallback is a constant that is public in this repo, so every instance that skipped it would hash visitor IPs identically |
| `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` | Object storage; uploads fail without a bucket. `R2_ENDPOINT` also builds the presigned URLs handed to the **browser**, so it must be browser-reachable, not merely reachable inside compose |

Optional and documented there too: `REDIS_URL`, `CRON_SECRET`, `METRICS_BEARER_TOKEN`, `BULL_BOARD_BASIC_AUTH_USER` / `_PASS` (the bullboard sidecar refuses to boot without them), `RESEND_API_KEY` (invitation and reset email), `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` (the deployment-default AI connection), `FONTO_VISION_URL` / `FONTO_VISION_KEY` (the optional vision sidecar), `FONTO_SERVICE_KEY` / `FONTO_SERVICE_KEY_V2` (the published `/api/peer/v1` surface), `FONTO_ALLOW_OPEN_SIGNUP`, `FONTO_INSTANCE_ADMINS`, `LOCAL_STORAGE_ROOT`, `PASSKEY_RP_ID`, `OIDC_*`, `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `NEXT_PUBLIC_DIRECT_UPLOAD`, `STRIPE_SECRET_KEY`, `AUDIT_RETENTION_DAYS`.

A few things that are easy to trip over:

- AI features are inert until you configure an intelligence tier — see below.
- Email is not sent without `RESEND_API_KEY`; the daily activity digest is a logging stub (`notifications.digest.email_stub`).
- Push notifications no-op without a Firebase service account.
- `next build` exceeds Node's default heap and dies with exit 134. `Dockerfile` defaults `NODE_HEAP_MB` to 4096 and honours `--build-arg NODE_HEAP_MB=…`; CI sets 6144.
- `PASSKEY_RP_ID` is derived from `PASSKEY_ORIGIN` / `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`, falling back to `localhost` (`lib/auth/passkey.ts`) — never to a real domain, so a misconfigured deploy cannot mint credentials bound to somebody else's hostname. The rpId is baked into every registered credential, so set it deliberately before your first user: changing it later forces everyone to re-register.
- Direct-to-storage uploads from the web UI are behind `NEXT_PUBLIC_DIRECT_UPLOAD` (off by default).
- `NEXT_PUBLIC_APP_URL` is a Docker **build** arg — Next.js inlines `NEXT_PUBLIC_*` at compile time, so changing it needs a rebuild, not a restart. The `Dockerfile` has no production default: omitting the arg yields `http://localhost:3500`, which makes a forgotten value fail visibly instead of silently wiring your instance to somebody else's domain.
- The `check-env-example.sh` guard only sees literal `process.env.X` reads, so two variables `lib/auth.ts` pulls in by destructuring — `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` — are absent from `.env.example` while their siblings (`OIDC_DISCOVERY_URL`, `OIDC_PROVIDER_ID`, `OIDC_SCOPES`, `OIDC_REDIRECT_BASE_URL`) are there.

## AI enrichment is optional

Classification, captioning, OCR, CLIP semantic search, face detection and CLIP-based duplicate detection all call an **external** intelligence tier over HTTP. Fonto does not bundle a model server, and it holds no credential on any other app's behalf.

The AI tier is **app-owned and user-configurable**. Each user points Fonto at a provider of their choosing in **Settings → Integrations** (label, base URL, model, API key — the key is AES-256-GCM encrypted at rest and never readable back), and the deployment may supply a default for users who have none:

- `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL` — the deployment-default AI connection (any Anthropic-compatible endpoint; a LiteLLM gateway is a common choice). The legacy `FONTO_LLM_BASE_URL` / `FONTO_LLM_KEY` names are still honored. This is the app's own credential, read by `lib/ai/connections.ts`.
- `FONTO_VISION_URL` (+ optional `FONTO_VISION_KEY`) — a CLIP / face / OCR vision service. There is **no** host default, so semantic search stays visibly off rather than silently dialling somebody else's box.
- `FONTO_SERVICE_KEY` — the inbound key for Fonto's published API (`/api/peer/v1/*`; see `public/.well-known/jex.manifest.json`). Unset means that optional surface answers 503 FEATURE_DISABLED.

Without any of them, Fonto still runs: uploads, EXIF, thumbnails, video derivatives, pHash duplicate detection, search, collections, shares and sync all work. The AI-dependent features degrade per capability — CLIP argmax classification, skipped captions/tags, OCR recorded as `failed`, unranked search — instead of failing the asset or blocking a core flow.

## Features

**Ingest**
- Multipart upload (50 MB default cap, `LEGACY_MAX_UPLOAD_BYTES`), presigned direct-to-storage upload with a 500 MB default cap (`MAX_UPLOAD_BYTES`), SHA-256 dedup and size verification, and resumable chunked uploads via tus.
- Imports: Google Takeout ZIP, Amazon Photos ZIP, Google Photos (picker), Google Drive (browse and single-file), Nextcloud/WebDAV. Archives stream to disk with sidecar metadata and a resumable cursor.
- Virtual folder paths preserved from all three upload paths.
- CLI folder sync and watch, with `.fonto-sync.json` state, `.fontoignore`, and `--pull` for bidirectional sync.

**Processing**
- Thumbnails (256px), previews (1080px WebP), a 4×4 LQIP, responsive derivatives.
- RAW and HEIC/AVIF decode — see `docs/raw-formats-supported.md`.
- Video probe, HLS ladder transcode, sprite sheet, playback proxy; motion-photo extraction.
- EXIF, GPS and offline reverse geocoding (GeoNames cities500).
- Duplicate detection: pHash Hamming distance at ingest, CLIP cosine similarity as a second pass.
- Variant stacking (RAW+JPEG, bursts) with read-only suggestions.
- Date intelligence: evidence extraction → fusion → proposed inference, with bucketed owner review and undo.
- Non-destructive rotate; crop-as-new.

**Browse and organize**
- Unified Library with chip filters (date, folder, classification, mime, favorite, rating, lifecycle, EXIF fields), keyset pagination, virtualized timeline and lightbox.
- Full-text search over filename, description and OCR text, plus colour matching and optional semantic re-rank.
- Collections and Smart Collections (a JSON query DSL covering `clipText`, `personIds`, `hasFaces`, `dominantColor`, `ratingMin` and more).
- Projects, clients, shoots and stages; personal vs shoot scope partitioning with bulk reassign and undo.
- Tags (AI-suggested vs user), People with face merge/split and groups, Map with bbox refetch and clustering, Memories ("on this day"), Duplicates review, favorites, 0–5 ratings, comments, trash with a 30-day purge grace.
- Bulk ZIP export and full JSON library export.

**Sharing and access**
- Public link shares for an asset or a collection: 8-char base62 slug, argon2id password, expiry up to one year, view cap, hashed-IP view log, rate limited.
- Cross-workspace asset sharing and a "shared with me" view.
- Workspace invitations with magic-link acceptance and revocation.
- Five workspace roles — `viewer < commenter < contributor < editor < owner` (`ROLE_RANK` in `lib/authz.ts`) — plus an instance-admin tier defined by the `FONTO_INSTANCE_ADMINS` email allowlist.
- Auth: email and password, passkeys/WebAuthn, one-time login links, optional OIDC SSO. Personal access tokens with `read|write|admin` scopes for programmatic access.

**Operations**
- Outbound webhooks with HMAC signing, per-delivery log and six-attempt backoff (1m, 5m, 15m, 1h, 6h).
- Audit log with 90-day retention pruning (`AUDIT_RETENTION_DAYS`).
- Prometheus metrics on the web app (`/api/metrics`) and worker (`/metrics`), OpenTelemetry, Grafana dashboards and alerts under `ops/`.
- Queue inspection at `/admin/jobs`, plus the optional bull-board sidecar.
- Interactive OpenAPI 3.1 reference at `/docs/api`.
- Storage placement policy (`r2_only` or `mirror`) with a local filesystem mirror, backfill and nightly reconcile.

## Architecture

Next.js 16 App Router + React 19 web app, a separate bare-Node BullMQ worker, and Postgres + Redis + S3 behind them. TypeScript throughout.

```
Client (web · Flutter app · CLI · API)
   │  tus / presigned PUT / multipart
   ▼
Next.js app  ── app/api/v1/*  (137 route handlers, keyset pagination)
   │  middleware.ts (edge auth + redirects)
   │  createAssetRow → insert + enqueue
   ▼
Postgres (Drizzle, `fonto` + `auth` schemas, pgvector)   Redis/Valkey (BullMQ)   S3-compatible storage
   ▲                                                     │
   └─────────────── worker/index.ts ◄────────────────────┘
        processAsset → classify · caption · OCR · thumbnails · HLS
                     → CLIP embed · face detect · date evidence/fusion
```

| Directory | Contents |
|---|---|
| `app/` | Next.js routes, pages and API handlers |
| `components/` | shadcn/ui components |
| `lib/` | Server logic: `db/`, `storage/`, `queue/`, `processing/`, `intelligence/`, `fusion/`, `evidence/`, `faces/`, `stacks/`, `classify/`, `sync/`, `webhooks/` |
| `worker/` | BullMQ worker process (bare Node — no dotenv in its import chain) |
| `bullboard/` | Queue admin sidecar (Express, basic auth, port 3300) |
| `cli/` | `@joeybuilt/fonto-cli` — a separate npm package, outside the pnpm workspace |
| `packages/fonto-sdk/` | Types and React hooks, `0.1.0-alpha.0` — the only workspace package; not imported by the app and not published by any workflow in this repo |
| `mobile/` | Flutter client (Android) |
| `drizzle/baseline/` | 2 baseline SQL files: the Better Auth `auth` schema and the 11 original `fonto` tables |
| `drizzle/migrations/` | 62 SQL migrations |
| `docker-compose.yml`, `Dockerfile.migrate` | The supported self-hosting topology and its one-shot migration runner |
| `scripts/` | Operator scripts and the CI gates (`db-apply.sh`, `scan-infra-identifiers.sh`, `check-env-example.sh`) |
| `ops/` | Prometheus, Grafana, Alertmanager, Caddy, worker autoscaler |
| `e2e/` | Playwright specs |

Layering follows the map in `.claude/rules/clean-architecture.md` as a target, not a finished state: date-fusion is genuinely pure (`lib/fusion/{fuse,combine,likelihoods,grid}.ts`) and storage sits behind `lib/storage/interface.ts`, but `lib/processing/`, `lib/evidence/` and several `lib/fusion/` backfill helpers import Drizzle and the queue directly, and route handlers contain inline queries. `.dependency-cruiser.cjs` enforces the intelligence boundary (the Anthropic SDK lives only in `lib/intelligence/adapters/`, adapters are reached only via `lib/intelligence/client`) and the single home for credential encryption (`lib/crypto/secret-box.ts`).

## API

REST under `/api/v1`, authenticated by session cookie, `Authorization: Bearer *** or `x-api-key`. The machine-readable contract lives in `lib/openapi/routes.ts` and is served at `GET /api/v1/openapi.json`; a Scalar UI renders it at `/docs/api`. `scripts/check-openapi-coverage.ts` tracks how much of the surface is described.

Highlights: `/assets` (CRUD, transform, reprocess, similar, tags, faces, comments, HLS, ZIP export), `/uploads` (presign, complete, tus), `/search` and `/search/clip`, `/collections`, `/smart-collections`, `/tags`, `/stacks`, `/projects`, `/clients`, `/shoots`, `/persons`, `/faces`, `/duplicates`, `/memories`, `/shares`, `/workspace`, `/tokens`, `/webhooks`, `/imports`, `/integrations`, `/sync/*` (sequence-cursor delta feeds for the CLI and mobile client), `/admin/*`.

Cron endpoints (`/api/v1/cron/*`) are gated by an `X-Cron-Secret` header matching `CRON_SECRET`: `purge-trashed`, `ocr-backfill`, `auto-cluster`.

## Background jobs

BullMQ over Redis/Valkey. Queues are declared in `lib/queue/queues.ts` and consumed in `worker/index.ts`: `asset-processing`, `thumbnails`, `clip-embedding`, `clip-dedup-check`, `face-detect`, `video-hls-transcode`, `media-import`, `storage-sync`, `webhook-delivery`, `extract-evidence`, `infer-date`, `maintenance`. (`ocr` is declared and enumerated by `allQueues()`, but no worker consumes it.)

Six repeatable jobs register unconditionally at boot, all via idempotent `upsertJobScheduler`: reap stuck assets (5 min), audit-log prune (24 h), daily activity digest (24 h), storage-usage reconcile (24 h), auto-stack (24 h) and the auto face-cluster scan (24 h). Six more are opt-in through env flags and are *actively removed* when off, so flipping a flag stops the tick instead of leaving a stale scheduler behind: `BACKFILL_FACE_CROPS`, `BACKFILL_EVIDENCE`, `BACKFILL_VARIANT_CANDIDATES`, `BACKFILL_INFERENCE`, `STORAGE_BACKFILL` and `STORAGE_RECONCILE` (the last two also require `LOCAL_STORAGE_ROOT`). `AUTO_STACK_ENABLED` is the exception — it defaults to **on** and registers a daily sweep that sets `stack_id` on variant groups; set it to `0` to disable, which also removes the scheduler.

Failure handling: heavy workers use a 5-minute lock with a 60-second stalled interval, `UnrecoverableError` opts out of retries, and a terminal attempt records `processing_state = 'failed'` with a reason so an undecodable file is never retried forever.

## CLI and mobile

**CLI** (`cli/`, `@joeybuilt/fonto-cli` 0.4.0) is a thin PAT client over `/api/v1`. It is not published to npm — no workflow in this repo runs `npm publish` — so install it from source:

```bash
cd cli && npm install && npm run build
node dist/index.js login --pat <token> --base-url https://fonto.example.com
node dist/index.js whoami
node dist/index.js ls --mime image/ --limit 20
node dist/index.js search "dog on beach"
node dist/index.js sync ./Photos --remote-prefix /Photos
```

Commands: `login`, `whoami`, `ls`, `search`, `upload`, `download`, `trash`, `restore`, `sc {list,run,create}`, `stacks {list,suggestions,accept}`, `folder {mv,rm}`, `sync`, `watch`. `FONTO_BASE_URL` and `FONTO_PAT` override the stored config.

**Mobile** (`mobile/`) is a Flutter client for **Android only** — there are no iOS platform files in this repository. It ships 26 Dart screens plus 5 shared widgets (library, search, asset detail, collections, people, duplicates, memories, shoots, tags, imports, tidy-up, transfers, updates, admin), 12 widget tests, a persistent SQLite upload queue with background drain, offline caching and prefetch, and push notifications.

The Android host shell is only partially committed — `mobile/android/gradle/wrapper/gradle-wrapper.properties` is there, but the `gradlew` script and wrapper jar are not — so bootstrap the platform files first. See `mobile/README.md`:

```bash
cd mobile
flutter create --project-name fonto_mobile --platforms=android .   # adds missing platform files; non-destructive
flutter pub get
flutter run            # an emulator or paired device must already be running
```

## Development

```bash
pnpm install --frozen-lockfile

pnpm dev                       # next dev -p 3500 (loads .env.local)
set -a; . ./.env.local; set +a # the worker is bare Node — it does NOT load .env.local
pnpm tsx worker/index.ts       # worker

pnpm test                      # vitest run — unit + colocated route tests
pnpm test:e2e                  # Playwright, needs a running instance and credentials

pnpm lint                      # eslint
pnpm typecheck                 # tsc --noEmit
pnpm arch                      # dependency-cruiser
pnpm conformance               # contract drift guard
pnpm scan:infra                # blocks committed infrastructure identifiers
pnpm check:env-example         # blocks .env.example drift
pnpm verify                    # typecheck + lint + arch + conformance + test
```

`pnpm verify` is the gate to run before pushing — it includes the test suite. Unit tests are colocated (`*.test.ts` next to the code they cover); `e2e/library-chips.spec.ts` runs against a live instance and expects `BASE_URL`, `PLAYWRIGHT_EMAIL`, `PLAYWRIGHT_PASSWORD` and a system Chromium.

Operator scripts: `pnpm db:{setup,generate,studio}`, `backfill:{exif,thumbnails,clip,faces,places,…}`, `scan:clip-duplicates`, `cluster:faces`, `reprocess:{stuck,one}`, `import:s3`, `autoscaler:start`.

CI (`.github/workflows/verify.yml`) runs on GitHub-hosted `ubuntu-latest`, on `pull_request` and on pushes to `main`: typecheck, lint, arch, conformance, `pnpm test`, `scan:infra` plus its `--self-test`, `check:env-example`, then `pnpm build`. `verify` is a required check on `main` and branch protection enforces it for admins too, so a red or missing run cannot be merged past. This workflow must stay on a hosted runner: for a `pull_request` event GitHub takes the job body from the PR's merge commit, so a fork controls it — contained on an ephemeral VM, unacceptable on a self-hosted runner holding the host Docker socket.

The docs landing gate (`scripts/check-docs.sh`) is deliberately **not** wired into `verify.yml`: it requires `CHANGELOG.md` to change in every code commit. The rationale and the one-line change to enable it are recorded in the workflow header, and `CHANGELOG.md` exists as the worklog target.

## Current limitations

Stated plainly so nothing here surprises you:

- No bundled AI/vision model server; AI features need an external service and degrade gracefully without one — the affected endpoints return an explicit `unavailable` response rather than failing the asset.
- No bundled geocoding dataset (`data/geonames/cities500.tsv` is a 51-line placeholder; run `scripts/fetch-geonames.ts`).
- No iOS app.
- No billing or hosted tier. `STRIPE_SECRET_KEY` only surfaces as a `stripeConfigured` flag in `/api/health`.
- `POST /api/v1/ask` is a stub returning `{ "stub": true }`; there is no chat-with-your-library feature.
- Share links support `asset` and `collection` targets only. Smart-collection (`set`) links are rejected at creation because the viewer has no render branch for them.
- The `local_only` storage policy exists as a type but has no write path; `storage()` always returns the R2 backend (`lib/storage/index.ts`).
- The daily activity digest logs instead of sending email.
- The `ocr` queue is declared but has no consumer; OCR runs inside the asset-processing pipeline.
- Test coverage is thin at the API layer: 18 non-mobile `*.test.ts` files (15 matched by `vitest.config.ts`; the three under `scripts/_scope/` are tsx harnesses), one Playwright spec, and 12 Flutter widget tests. `scripts/endpoint-test-allowlist.yaml` tracks 136 untested route handlers.
- Eleven routes are redirects to consolidated surfaces, enforced in `middleware.ts`: `/app/photos`, `/app/timeline`, `/app/folders`, `/app/documents` and `/app/trash` to `/app/library`; `/app/projects`, `/app/smart-collections` and `/app/stacks` to `/app/collections`; `/app/dashboard`, `/app/activity` and `/app/shared` to `/app/updates`. `/app/projects` and `/app/stacks` also keep page files that render their real content behind a deprecation banner.
- Some features are behind flags that are off by default: `NEXT_PUBLIC_DIRECT_UPLOAD`, `LIBRARY_SURFACE_SPLIT_ENABLED`, `USE_UNIFIED_ANALYZE`, and the six opt-in `BACKFILL_*` / `STORAGE_*` schedules.

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, `.claude/`, `.cursor/`, `.windsurf/` and `.clinerules/` are configuration for AI coding agents working in this repository. They are not user documentation.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `pnpm verify` — it includes the test suite, and CI will run it against your merge commit.
2. Keep dependencies pointing inward; do not add a Drizzle or HTTP import to a domain module to make a change land.
3. Add or update the colocated test for any route handler you touch, and delete its `scripts/endpoint-test-allowlist.yaml` entry — that list is shrink-only.
4. Update `CHANGELOG.md` in the same change as the code.
5. Never force-push or rewrite published history, and never commit an infrastructure identifier — production hostnames, deploy-box paths, internal container names and routable IPs. `scripts/scan-infra-identifiers.sh` blocks them in CI.

## License

[MIT](LICENSE) — Copyright (c) 2026 Joeybuilt LLC.

You may use, modify, distribute and self-host Fonto freely, including commercially, provided the copyright and permission notices are retained. There is no copyleft or network-use obligation.

A Joeybuilt product.
