<div align="center">
  <h1>Fonto</h1>
  <p><strong>Your AI-classified digital asset manager.</strong></p>
  <p>Photos, documents, scans, RAW files and video in one library — auto-tagged, OCR'd, deduped by perceptual hash, and searchable across every file type. Self-host on your own S3-compatible bucket and Postgres.</p>

  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://getplexo.com"><img src="https://img.shields.io/badge/Built%20on-Plexo-purple" alt="Built on Plexo" /></a>
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
- [License](#license)

## What it does

Upload a file and Fonto:

1. Stores it in S3-compatible object storage (Cloudflare R2 recommended) and writes an `assets` row in Postgres.
2. Queues it for processing: EXIF and GPS extraction, thumbnails and responsive derivatives, perceptual hash and dominant palette, RAW/HEIC decode, video probe plus HLS ladder and sprite sheet.
3. Enriches it if an AI tier is configured: classification, captioning, OCR text, CLIP embeddings for semantic search, face detection and clustering.
4. Reconciles the capture date from every piece of evidence it can find (EXIF, filename, sidecar, image content) and proposes a correction rather than overwriting your data.
5. Surfaces it in a single Library grid/timeline with filters, plus People, Map, Collections, Smart Collections, Stacks, Shoots, Duplicates, Memories and Imports views.

## What you need to run it

Fonto is a real, working application, but it is **not** a one-command install. It ships four Dockerfiles and no orchestration file, and you supply the backing services yourself.

| Requirement | Notes |
|---|---|
| Node 22 + pnpm 10 | Versions pinned by `Dockerfile` and `.github/workflows/verify.yml` |
| PostgreSQL with `pgvector` | Migration `0017_pgvector_setup.sql` runs `CREATE EXTENSION vector` |
| Redis or Valkey | BullMQ queues; the `REDIS_URL` default (`redis://valkey:6379`) only resolves inside a container network |
| S3-compatible object storage | Cloudflare R2 recommended; any S3-compatible endpoint works |
| Worker host tooling | `libheif`, `libraw`, `exiftool`, `ffmpeg`, `imagemagick`, `poppler-utils` — bundled in `Dockerfile.worker`, absent on a bare dev machine |

## Quick start

```bash
git clone https://github.com/joeybuilt-official/fonto.git
cd fonto
cp .env.example .env.local
pnpm install
```

Fill in `.env.local`: `DATABASE_URL`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `REDIS_URL`, and the `R2_*` storage keys. See [Configuration](#configuration). Note that `REDIS_URL` defaults to `redis://valkey:6379`, a container DNS name — override it to `redis://localhost:6379` (or wherever your Redis actually is) for local development.

Create the schema and the Postgres namespace Fonto's tables live in, then start both processes:

```bash
psql "$DATABASE_URL" -c 'CREATE SCHEMA IF NOT EXISTS fonto;'   # none of the migrations create it
pnpm db:push                    # create the schema from lib/db/schema.ts
pnpm dev                        # web app → http://localhost:3500
pnpm tsx worker/index.ts        # processing worker (separate terminal)
```

> **The worker does not read `.env.local`.** Next.js loads `.env.local` for `pnpm dev` only; `worker/index.ts` is a bare Node process with no dotenv anywhere in its import chain, so it will throw `DATABASE_URL environment variable is not set` on the first query and fall back to the container-only Redis default. Export the variables in the worker's shell (`set -a; . ./.env.local; set +a`) or run the worker in Docker with an env file.

> **Migration caveat.** `drizzle/migrations/` holds 62 hand-written SQL files, but no drizzle journal (`drizzle/meta/`) is committed, so `pnpm db:migrate` has nothing to replay on a fresh database. `pnpm db:push` is the working path for a new instance. To reproduce the historical schema instead, create the `fonto` schema first (as above) and apply the SQL files in filename order — they qualify every table with the `fonto` schema prefix but never create the schema itself.

The first account you create bootstraps the instance. **Registration is invite-only after that** — set `FONTO_ALLOW_OPEN_SIGNUP=true` to open it, or invite people from Settings ▸ Members.

Fetch the geocoding dataset if you want real place names on the map (the repo ships a placeholder):

```bash
pnpm tsx scripts/fetch-geonames.ts
```

### Containers

```bash
docker build -f Dockerfile -t fonto:dev .                     # web, EXPOSE 3500
docker build -f Dockerfile.worker -t fonto-worker:dev .         # processing worker
docker build -f Dockerfile.bullboard -t fonto-bullboard:dev .   # queue UI, EXPOSE 3300
docker build -f ops/autoscaler/Dockerfile -t fonto-autoscaler:dev .
```

There is no `docker-compose.yml` in this repository, and no automated migration-on-deploy step. Production wiring (reverse proxy, service definitions, backups) is left to the operator.

## Configuration

`.env.example` is the starting reference and marks each variable `[R]` required or `[O]` optional. It is not exhaustive: several variables listed below are read by the code but absent from it (each is linked to its reader so you can confirm the behaviour).

Required at boot:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection for Fonto's tables (pgvector required) |
| `AUTH_DATABASE_URL` | Better Auth tables; falls back to `DATABASE_URL` |
| `AUTH_SECRET` | Session signing (`openssl rand -hex 32`) |
| `NEXT_PUBLIC_APP_URL` | Public origin — OAuth callbacks, cookies, presigned upload hosts |
| `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` | Object storage; uploads fail without a bucket |

In `.env.example`: `REDIS_URL` (commented), `SHARE_LINK_IP_SALT`, `CRON_SECRET`, `METRICS_BEARER_TOKEN`, `BULL_BOARD_BASIC_AUTH_USER` / `_PASS` (the bullboard sidecar refuses to boot without them), `RESEND_API_KEY` (invitation and reset email), `PLEXO_URL` / `PLEXO_SERVICE_KEY`, `PLEXO_VISION_URL`.

Read by the code but **not** in `.env.example`: `FONTO_ALLOW_OPEN_SIGNUP` (`lib/auth.ts`), `FONTO_INSTANCE_ADMINS` (`lib/authz/instance.ts`), `LOCAL_STORAGE_ROOT` (`lib/storage/local-fs-backend.ts`), `PASSKEY_RP_ID` (`lib/auth/passkey.ts` — it defaults to a production domain, so set it for your own), `OIDC_*` (`lib/auth.ts`), `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` (`lib/integrations/google.ts`), `FIREBASE_SERVICE_ACCOUNT_JSON` (`lib/notifications/push.ts`), `FONTO_LLM_KEY` / `FONTO_LLM_BASE_URL` (`lib/intelligence/adapters/anthropic.ts`), `FONTO_VISION_URL` (`lib/intelligence/adapters/vision-sidecar.ts`).

A few things that are easy to trip over:

- AI features are inert until you configure an intelligence tier — see below.
- Email is not sent without `RESEND_API_KEY`; the daily activity digest is a logging stub.
- Push notifications no-op without a Firebase service account.
- `next build` needs roughly 4 GB of heap (`NODE_OPTIONS=--max-old-space-size=4096`); CI uses 6 GB.
- Direct-to-storage uploads from the web UI are behind `NEXT_PUBLIC_DIRECT_UPLOAD` (off by default).
- The `Dockerfile` build arg `NEXT_PUBLIC_APP_URL` has a hardcoded production default — pass your own.

## AI enrichment is optional

Classification, captioning, OCR, CLIP semantic search, face detection and CLIP-based duplicate detection all call an **external** intelligence service over HTTP. Fonto does not bundle a model server, and there is no vision sidecar in this repository or in the public Plexo repository.

Point Fonto at whatever serves those endpoints:

- `PLEXO_URL` + `PLEXO_SERVICE_KEY` — a [Plexo](https://getplexo.com) instance, which provides the model gateway, fallback chains and persistent memory.
- `FONTO_VISION_URL` (or `PLEXO_VISION_URL`) — a CLIP / face / OCR vision service.
- `FONTO_LLM_KEY` + `FONTO_LLM_BASE_URL` — a standalone Anthropic-compatible endpoint used when no Plexo deployment is configured.

Without any of them, Fonto still runs: uploads, EXIF, thumbnails, video derivatives, pHash duplicate detection, search, collections, shares and sync all work. The AI-dependent features degrade to a mime-type heuristic or return an explicit `unavailable` response instead of failing the asset.

## Features

**Ingest**
- Multipart upload (50 MB default cap), presigned direct-to-storage upload with SHA-256 dedup and size verification, and resumable chunked uploads via tus.
- Imports: Google Takeout ZIP, Amazon Photos ZIP, Google Photos (picker), Google Drive (browse and single-file), Nextcloud/WebDAV. Archives stream to disk with sidecar metadata and a resumable cursor.
- Virtual folder paths preserved from all three upload paths.
- CLI folder sync and watch, with `.fonto-sync.json` state, `.fontoignore`, and `--pull` for bidirectional sync.

**Processing**
- Thumbnails (256px), previews (1080px WebP), LQIP, responsive derivatives.
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
- Public link shares for an asset or a collection: base62 slug, argon2id password, expiry up to one year, view cap, hashed-IP view log, rate limited.
- Cross-workspace asset sharing and a "shared with me" view.
- Workspace invitations with magic-link acceptance and revocation.
- Five workspace roles — `viewer < commenter < contributor < editor < owner` — plus an instance-admin tier defined by the `FONTO_INSTANCE_ADMINS` email allowlist.
- Auth: email and password, passkeys/WebAuthn, one-time login links, optional OIDC SSO. Personal access tokens with `read|write|admin` scopes for programmatic access.

**Operations**
- Outbound webhooks with HMAC signing, per-delivery log and six-attempt backoff.
- Audit log with 90-day retention pruning.
- Prometheus metrics on the web app (`/api/metrics`) and worker (`/metrics`), OpenTelemetry, Grafana dashboards and alerts under `ops/`.
- Queue inspection at `/admin/jobs`, plus an optional bull-board sidecar.
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
Postgres (Drizzle, `fonto` schema, pgvector)   Redis/Valkey (BullMQ)   S3-compatible storage
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
| `worker/` | BullMQ worker process |
| `bullboard/` | Queue admin sidecar (Express, basic auth, port 3300) |
| `cli/` | `@joeybuilt/fonto-cli` — a separate npm package, outside the pnpm workspace |
| `packages/fonto-sdk/` | Types and React hooks, `0.1.0-alpha.0` — the only workspace package; not consumed by the app and not published by any workflow in this repo |
| `mobile/` | Flutter client (Android) |
| `drizzle/migrations/` | 62 SQL migrations |
| `ops/` | Prometheus, Grafana, Alertmanager, worker autoscaler |
| `e2e/` | Playwright specs |

Layering follows the map in `.claude/rules/clean-architecture.md` as a target, not a finished state: date-fusion is genuinely pure (`lib/fusion/{fuse,combine,likelihoods,grid}.ts`) and storage sits behind `lib/storage/interface.ts`, but `lib/processing/`, `lib/evidence/` and several `lib/fusion/` backfill helpers import Drizzle and the queue directly, and route handlers contain inline queries. `.dependency-cruiser.cjs` currently enforces only the intelligence boundary (the Plexo SDK is importable solely from `lib/intelligence/adapters/`, `lib/plexo.ts` and `lib/plexo-registration.ts`).

## API

REST under `/api/v1`, authenticated by session cookie, `Authorization: Bearer <PAT>` or `x-api-key`. The machine-readable contract lives in `lib/openapi/routes.ts` and is served at `GET /api/v1/openapi.json`; a Scalar UI renders it at `/docs/api`. `scripts/check-openapi-coverage.ts` tracks how much of the surface is described.

Highlights: `/assets` (CRUD, transform, reprocess, similar, tags, faces, comments, HLS, ZIP export), `/uploads` (presign, complete, tus), `/search` and `/search/clip`, `/collections`, `/smart-collections`, `/tags`, `/stacks`, `/projects`, `/clients`, `/shoots`, `/persons`, `/faces`, `/duplicates`, `/memories`, `/shares`, `/workspace`, `/tokens`, `/webhooks`, `/imports`, `/integrations`, `/sync/*` (sequence-cursor delta feeds for the CLI and mobile client), `/admin/*`.

Cron endpoints (`/api/v1/cron/*`) are gated by `X-Cron-Secret`: `purge-trashed`, `ocr-backfill`, `auto-cluster`.

## Background jobs

BullMQ over Redis/Valkey. Queues are declared in `lib/queue/queues.ts` and consumed in `worker/index.ts`: `asset-processing`, `thumbnails`, `clip-embedding`, `clip-dedup-check`, `face-detect`, `video-hls-transcode`, `media-import`, `storage-sync`, `webhook-delivery`, `extract-evidence`, `infer-date`, `maintenance`.

Repeatable jobs registered at boot: reap stuck assets (5 min), audit-log prune (24 h), storage-usage reconcile (24 h), auto-stack (24 h), auto face-cluster scan (24 h). Backfill schedules are opt-in through env flags and are actively removed when off.

Failure handling: heavy workers use a 5-minute lock with a 60-second stalled interval, `UnrecoverableError` opts out of retries, and a terminal attempt records `processing_state = 'failed'` with a reason so an undecodable file is never retried forever.

## CLI and mobile

**CLI** (`cli/`, `@joeybuilt/fonto-cli`) is a thin PAT client over `/api/v1`. It is not published to npm yet — install it from source:

```bash
cd cli && npm install && npm run build
node dist/index.js login --pat <token> --base-url https://your-instance.example
node dist/index.js ls --mime image/ --limit 20
node dist/index.js search "dog on beach"
node dist/index.js sync ./Photos --remote-prefix /Photos
```

Commands: `login`, `whoami`, `ls`, `search`, `upload`, `download`, `trash`, `restore`, `sc {list,run,create}`, `stacks {list,suggestions,accept}`, `folder {mv,rm}`, `sync`, `watch`. `FONTO_BASE_URL` and `FONTO_PAT` override the stored config.

**Mobile** (`mobile/`) is a Flutter client for **Android only** — there are no iOS platform files in this repository. It ships 26 Dart screen/widget files (library, search, asset detail, collections, people, duplicates, memories, shoots, tags, imports, tidy-up, transfers, updates, admin) plus 12 widget tests, a persistent SQLite upload queue with background drain, offline caching and prefetch, and push notifications.

The Android host shell is only partially committed (no Gradle wrapper), so bootstrap the platform files first — see `mobile/README.md`:

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

npx vitest run                 # unit + colocated route tests (there is no root `test` script)
pnpm test:e2e                  # Playwright, needs a running instance and credentials

pnpm lint                      # eslint
pnpm typecheck                 # tsc --noEmit
pnpm arch                      # dependency-cruiser
pnpm conformance               # contract drift guard
pnpm verify                    # typecheck + lint + arch + conformance
```

`pnpm verify` is the gate to run before pushing. Unit tests are colocated (`*.test.ts` next to the code they cover); `e2e/library-chips.spec.ts` runs against a live instance and expects `BASE_URL`, `PLAYWRIGHT_EMAIL`, `PLAYWRIGHT_PASSWORD` and a system Chromium.

Operator scripts: `pnpm db:{generate,migrate,push,studio}`, `backfill:{exif,thumbnails,clip,faces,places,…}`, `scan:clip-duplicates`, `cluster:faces`, `reprocess:{stuck,one}`, `import:s3`, `autoscaler:start`.

CI (`.github/workflows/verify.yml`) runs typecheck, lint, arch, conformance and build on a self-hosted runner. It does not run the test suite, so treat local `pnpm verify` plus `npx vitest run` as the real pre-merge gate.

## Current limitations

Stated plainly so nothing here surprises you:

- No `docker-compose.yml` and no working automated migration runner (`pnpm db:migrate` has no journal to replay) — use `pnpm db:push` on a fresh install.
- No bundled AI/vision model server; AI features need an external service and degrade gracefully without one — the affected endpoints return an explicit `unavailable` response rather than failing the asset.
- No bundled geocoding dataset (51-line placeholder; run `scripts/fetch-geonames.ts`).
- No iOS app.
- No billing or hosted tier. `STRIPE_SECRET_KEY` only surfaces as a `stripeConfigured` flag in `/api/health`.
- `POST /api/v1/ask` is a stub returning `{ "stub": true }`; there is no chat-with-your-library feature.
- Share links support `asset` and `collection` targets only. Smart-collection (`set`) links are rejected at creation because the viewer has no render branch for them.
- The `local_only` storage policy exists as a type but has no write path; `storage()` always returns the R2 backend.
- The daily activity digest logs instead of sending email.
- Test coverage is thin at the API layer: 16 colocated `*.test.ts` files (13 of them matched by `vitest.config.ts`; the `scripts/_scope/*` ones are tsx harnesses), one Playwright spec, and 12 Flutter widget tests. `scripts/endpoint-test-allowlist.yaml` tracks 136 untested route handlers.
- Several pages are redirects to the unified Library (`/app/photos`, `/app/timeline`, `/app/folders`, `/app/documents`, `/app/trash`, `/app/projects`, `/app/stacks`, `/app/dashboard`, `/app/activity`, `/app/shared`).
- Some features are behind flags that are off by default: `NEXT_PUBLIC_DIRECT_UPLOAD`, `LIBRARY_SURFACE_SPLIT_ENABLED`, `USE_UNIFIED_ANALYZE`, and the `BACKFILL_*` schedules.
- Auto-stacking is the opposite: `AUTO_STACK_ENABLED` defaults to **on** and registers a daily sweep that sets `stack_id` on variant groups. Set it to `0` to disable, which also removes the scheduler.

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, `.claude/`, `.cursor/`, `.windsurf/` and `.clinerules/` are configuration for AI coding agents working in this repository. They are not user documentation.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `pnpm verify` and `npx vitest run` — both must pass.
2. Keep dependencies pointing inward; do not add a Drizzle or HTTP import to a domain module to make a change land.
3. Add or update the colocated test for any route handler you touch.
4. Update the docs in the same change as the code.

## License

[MIT](LICENSE) — Copyright (c) 2026 Joeybuilt LLC.

You may use, modify, distribute and self-host Fonto freely, including commercially, provided the copyright and permission notices are retained. There is no copyleft or network-use obligation.

Built on [Plexo](https://getplexo.com) for its intelligence layer. A Joeybuilt product.
