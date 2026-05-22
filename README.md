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

**Inspect queues:** `/admin/jobs` shows live waiting/active/completed/failed
counts. A full bull-board UI is deferred to Phase 0.6 — see the TODO in
`app/admin/jobs/page.tsx`.

## Built on Plexo

Fonto is a [Plexo](https://getplexo.com) App Profile. Asset classification, tag suggestions, and image description all route through Plexo's model gateway. Plexo also adds persistent memory — Fonto remembers tag preferences and classification corrections across sessions. See `lib/plexo.ts` and `lib/plexo-registration.ts` for the integration surface.

## License

[AGPL-3.0-only](./LICENSE) — Copyright (C) 2026 Joeybuilt LLC.

If you modify Fonto and run it as a network service, you must share your modifications under the same license. For commercial use without copyleft obligations, contact us.
