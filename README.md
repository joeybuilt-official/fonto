<div align="center">
  <h1>Fonto</h1>
  <p><strong>Your AI-classified digital asset manager.</strong></p>
  <p>Photos, documents, and scans in one library — auto-tagged, OCR'd, deduped via perceptual hashing, and searchable across every file type. Self-host on your own R2 bucket and Postgres.</p>

  <a href="https://github.com/joeybuilt-official/fonto/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://getplexo.com"><img src="https://img.shields.io/badge/Built%20on-Plexo-purple" alt="Built on Plexo" /></a>
</div>

## Features

- **Universal Capture** — Photos, documents, scans. Every file type, one intake.
- **AI Classification** — Automatic tagging, categorization, and metadata extraction via Plexo.
- **Perceptual Dedup** — Near-duplicate detection across photos using pHash + color-based nearest-neighbor.
- **OCR** — Documents and scanned images get full-text searchable.
- **Unified Search** — Find anything across photos and documents in one query.
- **Timeline View** — Chronological browse of your entire library.
- **Collections + Smart Collections** — Manual albums and rule-based dynamic ones.
- **R2 Storage** — Cloudflare R2 backend. Durable, fast, egress-free.

## Cloud vs Self-Host

| | Cloud | Self-Host |
|---|---|---|
| **Setup** | (coming soon at getfonto.com) | `docker compose up -d` |
| **Storage** | Managed R2 bucket | Bring your own R2 / S3-compatible |
| **AI** | Managed Plexo Core | Bring your own Plexo deployment (or run standalone) |
| **Best for** | Most users | Privacy-first, full data ownership |

## Quick Start (Self-Host)

```bash
git clone https://github.com/joeybuilt-official/fonto.git
cd fonto
cp .env.example .env.local
# Fill in DATABASE_URL, R2 keys, and (optionally) PLEXO_URL
pnpm install
pnpm db:migrate
pnpm dev
```

Open [http://localhost:3500](http://localhost:3500).

### Self-Hosting Notes

**Plexo integration is optional but recommended.** Fonto is a [Plexo](https://getplexo.com) App Profile — AI classification, tagging, and OCR route through Plexo's model gateway with automatic fallback chains. Without `PLEXO_URL` set, Fonto runs in standalone mode: uploads work, search works, but AI features no-op gracefully. To enable the full experience, point Fonto at a Plexo Core instance (your own or a hosted one) via `PLEXO_URL` + `PLEXO_SERVICE_KEY`.

**Billing/Stripe is not implemented.** The `STRIPE_SECRET_KEY` env that appears in the health endpoint is a placeholder for a future Joeybuilt Cloud tier and has no effect on self-hosted instances. Leave it unset.

**Storage requires R2 or S3-compatible.** Fonto uses presigned URLs for direct browser uploads. Any S3-compatible provider works — Cloudflare R2 is recommended (zero egress fees).

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16, React 19 |
| Language | TypeScript |
| Database | PostgreSQL (Drizzle ORM) |
| Auth | Better Auth |
| Storage | Cloudflare R2 / S3-compatible |
| AI | Plexo Core (optional) |
| Image Processing | sharp, pHash |
| Background Jobs | BullMQ + Redis/Valkey |
| UI | Tailwind CSS v4, shadcn/ui |

## Background Jobs (Worker Container)

Asset processing (classification, OCR, perceptual hash, tag suggestion) runs
as BullMQ jobs against a Redis/Valkey instance. The Next.js API enqueues; a
separate worker container drains. A restart no longer drops in-flight work.

**Env vars:**
- `REDIS_URL` — defaults to `redis://valkey:6379`
- `WORKER_CONCURRENCY` — worker only, defaults to `4`
- `LOG_LEVEL` — `info` (default), `debug`, `warn`, `error`
- `REAPER_STUCK_THRESHOLD_MINUTES` — worker only, defaults to `60`. Rows in
  `processing_state='processing'` whose `updated_at` is older than this are
  considered abandoned by a dead worker.
- `REAPER_INTERVAL_MS` — worker only, defaults to `300000` (5 min). How often
  the maintenance worker re-runs the stuck-assets sweep.

**Run the worker locally:**
```bash
pnpm tsx worker/index.ts
```

**Build + run the worker image:**
```bash
docker build -f Dockerfile.worker -t fonto-worker:dev .
docker run --rm \
  -e REDIS_URL=redis://valkey:6379 \
  -e DATABASE_URL=$DATABASE_URL \
  -e R2_BUCKET=$R2_BUCKET -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... \
  -e PLEXO_URL=... -e PLEXO_SERVICE_KEY=... \
  fonto-worker:dev
```

**Retry semantics:** 5 attempts with exponential backoff starting at 2s
(`defaultJobOptions` in `lib/queue/queues.ts`). Successful jobs are kept for
the last 1000; failures are kept indefinitely for inspection. The
`assets.processing_error` column records the most recent failure message;
`assets.processing_attempts` counts every worker pickup.

**Inspect queues:** `/admin/jobs` is the operator landing page. Workspace-owner
gated. When `BULL_BOARD_URL` is set it links to the bull-board sidecar; the
live-counts table is shown as a fallback either way.

### Bull-board UI (sidecar)

The full bull-board admin UI — retry, promote, clean, inspect job payloads —
runs as a separate Express container (`Dockerfile.bullboard`), not as part of
the Next.js app. The sidecar pattern mirrors the worker, dodges Next 16 +
Express integration friction, and lets the UI scale independently.

**Env vars:**
- `BULL_BOARD_BASIC_AUTH_USER` — required; sidecar refuses to start if unset
- `BULL_BOARD_BASIC_AUTH_PASS` — required; sidecar refuses to start if unset
- `BULL_BOARD_PORT` — defaults to `3300`
- `REDIS_URL` — same Valkey instance as the worker
- `BULL_BOARD_URL` — set on the Next.js app so `/admin/jobs` surfaces a link

**Run locally:**
```bash
BULL_BOARD_BASIC_AUTH_USER=ops \
BULL_BOARD_BASIC_AUTH_PASS=changeme \
pnpm tsx bullboard/index.ts
# → http://localhost:3300/  (basic-auth: ops / changeme)
```

**Build + run the sidecar image:**
```bash
docker build -f Dockerfile.bullboard -t fonto-bullboard:dev .
docker run --rm -p 3300:3300 \
  -e REDIS_URL=redis://valkey:6379 \
  -e BULL_BOARD_BASIC_AUTH_USER=ops \
  -e BULL_BOARD_BASIC_AUTH_PASS=$(openssl rand -hex 24) \
  fonto-bullboard:dev
```

**Recommended Caddy reverse-proxy snippet** (terminate TLS at Caddy; never
expose Basic-auth credentials over plain HTTP):

```caddyfile
ops.example.com {
  handle_path /fonto/jobs/* {
    reverse_proxy fonto-bullboard:3300
  }
}
```

**Why a sidecar instead of an in-app route?** Bull-board ships an Express
adapter; running it in its own process matches the worker's deploy story,
keeps admin-only code out of the Next.js bundle, and avoids App Router +
Express middleware integration friction (see ADR 0005 and ADR 0006).

**Stuck-asset reaper (Phase 0.2):** A second `maintenance` queue hosts a
recurring `reap-stuck-assets` job (registered at worker boot via BullMQ's
`upsertJobScheduler`). Every 5 minutes by default, it scans
`fonto.assets WHERE processing_state='processing' AND updated_at < now() - interval '1 hour'`
and either re-enqueues the row on `asset-processing` (when
`processing_attempts < 5`) or terminally marks it `processing_state='failed'`
with `processing_error='reaped after 5 attempts stuck >1h'`. This is the
belt-and-braces guard against worker crashes (SIGKILL/OOM/container drift)
that leave rows orphaned in `processing` forever. See
`lib/processing/reapStuckAssets.ts`.

## Observability

Fonto ships first-class metrics and tracing — both Prometheus-native and
OpenTelemetry-friendly. Everything is opt-in via env: with `METRICS_BEARER_TOKEN`
unset, the scrape endpoints return 503; with `OTEL_EXPORTER_OTLP_ENDPOINT`
unset, the OTel SDK never starts.

**Prometheus scrape endpoints:**
- Web: `GET /api/metrics` on the Next.js app (Node runtime, not edge).
- Worker: `GET /metrics` on the worker container, port `WORKER_METRICS_PORT`
  (default `9464`).

Both require `Authorization: Bearer $METRICS_BEARER_TOKEN`. Example scrape
config:

```yaml
scrape_configs:
  - job_name: fonto-web
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: ${METRICS_BEARER_TOKEN}
    static_configs:
      - targets: ['fonto-web:3500']
  - job_name: fonto-worker
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: ${METRICS_BEARER_TOKEN}
    static_configs:
      - targets: ['fonto-worker:9464']
```

**Custom metrics:**
- `fonto_http_request_duration_seconds{method,route,status_code}` — histogram
  of API request latency. Currently observed on `POST /api/v1/assets`.
- `fonto_asset_processing_duration_seconds{outcome=success|failure}` —
  histogram of the full post-upload pipeline (classification, OCR, tags).
- `fonto_asset_processing_queue_depth{queue}` — gauge polled every 10s from
  BullMQ (`waiting + active + delayed`).
- `fonto_asset_ingest_total{mime_class=image|video|document|other}` — counter
  bumped on every successful upload.
- Plus the default Node process metrics (`fonto_process_*`,
  `fonto_nodejs_*`).

**OpenTelemetry:**
Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` (no trailing
slash; the SDK appends `/v1/traces` and `/v1/metrics`). Service names default
to `fonto-web` and `fonto-worker`; override with `OTEL_SERVICE_NAME`.
Auto-instrumentation covers `http`, `pg`, `ioredis`, and `bullmq`.

## Resumable uploads (tus)

Large originals (4K phone video, RAW photos, DSLR JPEGs over the 50 MB
`POST /api/v1/assets` limit) go through the tus endpoint at
`/api/v1/uploads/tus`. tus chunks the file client-side, streams each chunk
into an R2 multipart upload, and survives flaky networks — a dropped
connection resumes from the last completed part instead of restarting.

**Defaults:**
- Chunk size: **8 MiB** (`TUS_PART_SIZE_BYTES`).
- Max file size: **10 GiB** (`TUS_MAX_FILE_SIZE_BYTES`).
- Auth: same Better Auth session cookie as the rest of the API. (Phase 2 will
  add bearer-token PAT auth for the CLI.)

**From the Fonto web app:**
```ts
import { uploadTus } from "@/lib/upload-client-tus";

const { assetId } = await uploadTus(file, {
  onProgress: (loaded, total) => console.log(loaded / total),
});
```

**From a third-party `tus-js-client`:**
```ts
import * as tus from "tus-js-client";

const upload = new tus.Upload(file, {
  endpoint: "https://fonto.example.com/api/v1/uploads/tus",
  chunkSize: 8 * 1024 * 1024,
  metadata: { filename: file.name, filetype: file.type },
  onSuccess: () => console.log("done"),
});
upload.start();
```

After the final chunk lands, the server assembles the multipart upload,
server-side-copies the object to `fonto/{workspaceId}/{assetId}/{filename}`,
inserts a `fonto.assets` row, and enqueues the same processing pipeline as
the regular upload path. The new `assetId` is returned to clients in the
`X-Fonto-Asset-Id` response header on the final PATCH.

The R2 bucket needs the standard tus CORS doc applied (PUT/POST/PATCH/HEAD/
DELETE on the upload prefix). See `docs/r2-cors.json` (lands with Phase 1.2).

## Built on Plexo

Fonto is a [Plexo](https://getplexo.com) App Profile. Asset classification, tag suggestions, and image description all route through Plexo's model gateway. Plexo also adds persistent memory — Fonto remembers tag preferences and classification corrections across sessions. See `lib/plexo.ts` and `lib/plexo-registration.ts` for the integration surface.

## License

[AGPL-3.0-only](./LICENSE) — Copyright (C) 2026 Joeybuilt LLC.

If you modify Fonto and run it as a network service, you must share your modifications under the same license. For commercial use without copyleft obligations, contact us.
