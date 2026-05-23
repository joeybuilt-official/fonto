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

## Direct-to-R2 Uploads

Fonto supports two upload paths. The legacy one (`POST /api/v1/assets` with a multipart body) buffers the whole file in the Next.js server and caps at 50 MB. The Phase 1.2 path streams direct to R2 and supports much larger files (default 500 MB, configurable via `MAX_UPLOAD_BYTES`).

The direct path is two requests:

1. `POST /api/v1/assets/init` with `{ filename, mimeType, sizeBytes, clientChecksum? }` — returns `{ uploadId, presignedUrl, headers, expiresIn }`. The presigned URL is valid for 15 minutes.
2. The client `PUT`s the file body straight to `presignedUrl` using the exact `headers` returned. The server never sees the bytes here.
3. `POST /api/v1/assets/{uploadId}/complete` — the server `HEAD`s R2 to confirm size, stream-hashes the object for SHA-256 dedup, runs EXIF / pHash / queue enqueue, and returns the same `{ asset, possibleDuplicate? }` shape as the legacy POST.

The web client implementation is in `lib/upload-client.ts` (`uploadDirect(file, ...)`). Set `NEXT_PUBLIC_DIRECT_UPLOAD=true` to flip the dashboard onto the new path.

### R2 CORS setup

The browser PUT requires CORS on the R2 bucket. A starter policy lives at `docs/r2-cors.json` (edit `AllowedOrigins` to match your deployment). Apply via Cloudflare dashboard, or with the AWS CLI pointed at the R2 endpoint:

```bash
aws s3api put-bucket-cors \
  --endpoint-url "$R2_ENDPOINT" \
  --bucket "$R2_BUCKET" \
  --cors-configuration file://docs/r2-cors.json
```

## Multi-user workspaces

Fonto workspaces moved from single-owner to multi-member in Phase 3.1. The model is intentionally narrow: three roles, no custom RBAC, no guest accounts. See [ADR 0004 — Multi-user workspace memberships](docs/adr/0004-multi-user-workspace-memberships.md) and [ADR 0007 — Link-only external sharing](docs/adr/0007-link-only-external-sharing.md) for the full rationale.

| Role | Can do |
|---|---|
| **owner** | Everything. Billing, delete workspace, manage members. One per workspace. |
| **editor** | Upload, edit, delete assets; manage collections, tags, projects, shares, webhooks. Cannot remove the owner or delete the workspace. |
| **viewer** | Read-only. Sees the workspace and downloads originals (subject to workspace policy). |

Membership lives in `fonto.workspace_memberships`. Every mutating `/api/v1/*` route calls `requireWorkspaceAccessOrResponse(userId, workspaceId, 'editor')` from `lib/authz.ts` — there is no `where: { workspaceId }` query that doesn't go through the gate. Run `pnpm tsx scripts/check-workspace-isolation.ts` for the audited manifest.

### Inviting a collaborator

The invite flow (`workspace_invitations` table + magic-link acceptance) lands in **Phase 3.3** (migration 0014). Until then, memberships can only be created by the application — `ensurePersonalWorkspace` writes the owner row, no one else gets membership. `GET /api/v1/workspace/members` lists who's currently on the workspace.

### Schema notes

- `workspaces.user_id` lingers as the "personal owner pointer" for one release — Phase 3.x may drop it once all call sites are migrated to `assertWorkspaceAccess`.
- Backfill in migration `0012` inserts one `owner` membership for every existing workspace, idempotently.
- `workspace_memberships.user_id` is `text` (matches Better Auth's `auth.user.id`), not uuid — keep this in mind if you write raw SQL.

## Sharing

Fonto generates public, link-only share URLs for individual assets, collections, and (eventually) smart sets. Per [ADR 0004](docs/adr/0004-multi-user-workspace-memberships.md), external sharing is link-only — anonymous viewers never get a workspace membership.

### Link types

| Type | Payload | URL |
|---|---|---|
| `asset` | One asset (image / PDF / file). | `/share/{slug}` — inline preview + optional download. |
| `collection` | A manual collection's current contents (up to 500 assets, thumbnailed grid). | `/share/{slug}` |
| `set` | A smart collection (rule-based). *Stub for now — preview-only.* | `/share/{slug}` |

Slugs are 8-character base62, collision-checked at insert. Legacy long random tokens from Phase 1 are still resolved (the route accepts either).

### API

- `POST /api/v1/shares` — create a link. Body:
  ```json
  {
    "targetType": "asset" | "collection" | "set",
    "targetId": "uuid",
    "password": "optional string (>= 4 chars)",
    "allowDownload": true,
    "maxViews": 100,
    "expiresAt": "2026-12-31T23:59:59Z"
  }
  ```
  Returns `{ id, slug, url, ... }`. All optional fields default to "unbounded".
- `GET /api/v1/shares` — list active shares in the caller's workspaces.
- `DELETE /api/v1/shares/:id` — revoke (soft — the row stays for the view-count audit trail).
- `GET /api/v1/shares/:id/views` — last 50 access events (timestamp, hashed IP, user-agent, success).

The legacy `POST/GET/DELETE /api/v1/assets/:id/share` endpoint stays in place for one release and writes through the new schema (default: 24h TTL, no password, downloads allowed).

### Password protection

Passwords are hashed with **argon2id** at OWASP 2025 parameters (`m=64 MiB`, `t=3`, `p=1`). Verification is constant-time via `@node-rs/argon2`. A failed attempt records a `success=false` row in `share_link_views`.

The viewer submits the password via `?p=<plain>` on the share URL (the password prompt page submits a GET form). Wrong password → re-render the prompt; never leak whether the slug exists.

### Expiry & view caps

- `expiresAt` — optional ISO timestamp; `NULL` means "never expires". Capped at 1 year out at create-time.
- `maxViews` — optional integer; once `viewCount >= maxViews`, the link 404s. Failed password attempts do NOT consume views.
- `lastAccessedAt` is bumped only on successful resolves.

### Rate limiting

Per-IP sliding-window: **30 requests / 60 seconds**, enforced on the `/share/*` route via the shared Valkey (`sharelink:rate:{ipHash}` keys). Over-quota → a friendly "Too many requests" page. Fails open if Valkey is unreachable. Tune via `lib/share-links/rate-limit.ts`.

### Privacy

The raw client IP is never persisted. Each access row stores `sha256(SHARE_LINK_IP_SALT + ip)`. Set `SHARE_LINK_IP_SALT` per deployment (generate: `openssl rand -hex 32`) — rotating it invalidates all existing analytics (intentional). Referers are truncated to 500 chars.

## Inviting members

Workspaces are multi-user — the owner can invite collaborators as `editor` (upload, edit, delete) or `viewer` (read-only). Roles and the model are documented in [ADR 0004](docs/adr/0004-multi-user-workspace-memberships.md).

### Sending an invitation

From `/app/settings/members` enter an email and pick a role, or post to the API directly:

```bash
curl -X POST https://your-fonto.example/api/v1/workspace/invitations \
  -H "content-type: application/json" \
  -H "cookie: fonto.session_token=..." \
  -d '{ "email": "friend@example.com", "role": "viewer" }'
```

The response includes the plaintext acceptance URL:

```json
{
  "id": "…",
  "token": "8tQ…",
  "url": "https://your-fonto.example/invitations/8tQ…",
  "expiresAt": "2026-05-30T17:24:00.000Z"
}
```

Invitations expire after `WORKSPACE_INVITATION_TTL_DAYS` (default 7). They have one acceptable use.

### Email delivery

Phase 3.3 ships **without an email transport** — the parity plan defers email infrastructure (nodemailer + react-email) to Phase 7.3. Until then, share the URL from the response manually. The settings UI also surfaces a Copy link button on every pending invitation.

### Acceptance flow

1. Recipient opens `/invitations/{token}`. The page renders publicly (no login required for the metadata view).
2. If signed in with the matching address → Accept POSTs to `/api/v1/workspace/invitations/{token}/accept`, the membership is created, and the user lands on the dashboard.
3. If not signed in → the page links to `/login?callback=/invitations/{token}&invitation={token}&email=…`. After signup (the form defaults to signup when arriving via this link) the user is bounced back to the acceptance page, where the Accept button retries.

### Revocation

`DELETE /api/v1/workspace/invitations/{tokenOrId}` flips `revoked_at`. Already-accepted invitations cannot be revoked (the membership row is the source of truth at that point — revoke that instead).

## Duplicate detection

Every image upload runs two passes of duplicate detection. Both produce the same `possibleDuplicate` payload on the upload response, discriminated by a `method` field so the UI can vary the banner copy.

### 1. pHash (always on)

A 64-bit perceptual hash (sign-of-DCT-coefficients) is computed in-process at ingest. The new asset's hash is compared with every other active asset's hash in the same workspace; matches at **Hamming distance ≤ 5** are flagged. This catches:

- Identical images uploaded twice (different filenames or sources)
- The same image at a different resize or JPEG quality
- Minor color shifts / metadata strips

pHash is sub-millisecond and runs synchronously inside the upload request — there's never a fallback path.

### 2. CLIP cosine similarity (Phase 4.5; second pass)

After pHash returns no hit, Fonto computes a 512-d CLIP embedding for the image and queries the workspace's vector index. Matches above the configured similarity threshold (default **0.92**, matching Immich's pre-tuned value) are flagged. This catches what pHash structurally cannot:

- Re-crops of the same scene
- Color-graded re-edits / filter passes
- Different framings of the same subject

The embed call can be slow (200–500 ms against a healthy vision service, more under load), so the pass runs against a budget: if the embed lands within `CLIP_DEDUP_INLINE_TIMEOUT_MS` (default 2000) the dedup banner ships in the upload response; otherwise the upload returns immediately and the `clip-dedup-check` BullMQ worker handles the check out-of-band. Either way, `clip_dedup_checked_at` is stamped so the same row is never processed twice.

The CLIP pass degrades to a no-op when no vision service is wired (`PLEXO_VISION_URL` unset), when the upstream embed hasn't yet written `clip_vec` for the row, or when pHash already produced a match.

### Operator tooling

- `pnpm scan:clip-duplicates` — bulk-scan every workspace's unchecked assets and emit a JSONL report. Supports `--workspace=<uuid>`, `--threshold=<0..1>`, `--batch=<n>`, `--limit=<n>`, and `--mark-checked`.
- Env knobs: `CLIP_DEDUP_THRESHOLD`, `CLIP_DEDUP_INLINE_TIMEOUT_MS`, `CLIP_DEDUP_WORKER_CONCURRENCY`, `CLIP_DEDUP_RETRY_DELAY_MS`.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16, React 19 |
| Language | TypeScript |
| Database | PostgreSQL (Drizzle ORM) |
| Auth | Better Auth |
| Storage | Cloudflare R2 / S3-compatible |
| AI | Plexo Core (optional) |
| Image Processing | sharp, pHash, CLIP (Phase 4.5) |
| Background Jobs | BullMQ + Redis/Valkey |
| UI | Tailwind CSS v4, shadcn/ui |

## Authentication

Fonto supports two authentication modes:

| Caller | Mode | Header |
|---|---|---|
| Web app | Session cookie (Better Auth) | (automatic via browser) |
| CLI, mobile, 3rd-party | Personal Access Token (PAT) | `Authorization: Bearer fonto_pat_…` or `x-api-key: fonto_pat_…` |

### Creating a Personal Access Token

1. Sign in to the web app and open **Settings → Personal access tokens**
   (`/app/settings/tokens`).
2. Click **Create token**. Pick a name (e.g. *MacBook CLI*), one or more
   scopes, and an expiry (30 / 90 / 365 days, or never).
3. The full token is shown **exactly once**. Copy it to a password manager
   immediately — Fonto stores only a SHA-256 hash and cannot recover it.

Tokens are formatted as `fonto_pat_<id>_<secret>` so they are recognizable
in logs and `grep`-able in source. Treat them like passwords: never commit
to source control, never share, rotate if leaked.

### Sending a token

Either header works. `x-api-key` takes precedence when both are present:

```bash
# Bearer
curl -H "Authorization: Bearer fonto_pat_..." https://your-fonto/api/v1/assets

# Or x-api-key
curl -H "x-api-key: fonto_pat_..." https://your-fonto/api/v1/assets
```

### Scopes

Three coarse scopes; higher scopes imply lower ones (`admin` ⊃ `write` ⊃ `read`):

| Scope | Grants |
|---|---|
| `read` | List, read, search assets / collections / tags |
| `write` | Upload, edit, delete assets; manage collections |
| `admin` | Manage workspace settings; manage members (Phase 3+) |

Routes that mutate state call `requireScope(token, 'write')` (or `'admin'`).
Read-only routes require no scope check — `read` is the default scope on
every key.

### Rate limiting

Each key gets **600 requests / 60 seconds** (≈ 10 rps) by default. The
window is per-key and sliding; it resets on process restart. Exceeding it
returns 401. Distributed / fleet-wide rate limiting belongs at the edge
(Caddy / Cloudflare) and is not the same control.

### Revoking a token

From **Settings → Personal access tokens**, click **Revoke** on any active
token. The key is marked revoked immediately and the next API call using
it gets `401 Unauthorized`. Revocation is soft (audit-friendly); to purge,
delete the row in `fonto.api_keys`.

### Token management is session-only

`POST` / `DELETE` on `/api/v1/tokens` accept **session auth only**, not PAT
auth. A PAT cannot mint or revoke other PATs — physical browser-session
ownership is the only path to new credentials. This blocks the obvious
privilege-escalation path of a leaked PAT minting a longer-lived one.

## Background Jobs (Worker Container)

Asset processing (classification, OCR, perceptual hash, tag suggestion) runs
as BullMQ jobs against a Redis/Valkey instance. The Next.js API enqueues; a
separate worker container drains. A restart no longer drops in-flight work.

**Env vars:**
- `REDIS_URL` — defaults to `redis://valkey:6379`
- `WORKER_CONCURRENCY` — worker only, defaults to `4`
- `THUMBNAIL_WORKER_CONCURRENCY` — worker only, defaults to `2`. Concurrency
  for the Phase 1.1 thumbnails worker (sharp encode + R2 PUT). CPU-bound;
  keep lower than `WORKER_CONCURRENCY` so the umbrella processAsset pipeline
  isn't starved on small boxes. Note: each generated asset adds roughly
  **~30%** to R2 storage (256px thumb + 1080px preview, both WebP) — plan
  bucket capacity accordingly. Backfill with `pnpm backfill:thumbnails`.
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

## OCR (PaddleOCR PP-OCRv5)

Image assets are OCR'd by the post-upload pipeline and surfaced via
`assets.ocr_text` (full-text search) and `assets.ocr_boxes` (per-line
bounding boxes for the lightbox text-region highlighter, Phase 4.4).

**Default path** — Fonto calls `POST /vision/ocr` on the Plexo Vision
sidecar (`apps/vision`), which serves [PaddleOCR PP-OCRv5][paddleocr] via
ONNX runtime. PaddleOCR is Apache 2.0; the PP-OCRv5 base model weights
ship with 80+ languages out of the box (default: English + Chinese).
Per-image latency is typically tens of milliseconds vs. ~3s for the
previous LLM-based path.

[paddleocr]: https://github.com/PaddlePaddle/PaddleOCR

**Fallback path** — set `OCR_LLM_FALLBACK=true` to retain the original
Plexo Core LLM-based OCR. When the vision sidecar is unreachable or
errors, the worker re-attempts via `sdk.visionOcr`. Per-line bounding
boxes are NOT recorded on this path (the LLM doesn't return them) — only
the concatenated text.

**Languages** — pass an ISO-639-1 code via `OCR_DEFAULT_LANG` (e.g. `en`,
`zh`, `ja`, `de`). The PP-OCRv5 detector is language-agnostic; the
recognizer is selected per request.

**State machine** — `assets.ocr_state`:

| State     | Meaning                                                              |
|-----------|----------------------------------------------------------------------|
| `pending` | image asset, hasn't been processed yet                               |
| `ready`   | OCR ran and produced text                                            |
| `empty`   | OCR ran successfully but found no text (e.g. solid-colour photo)     |
| `failed`  | OCR pipeline errored (model unreachable, decode error, etc.)         |
| `skipped` | non-image MIME type — OCR was never attempted                        |

`empty` is intentionally distinct from `skipped` (we didn't try) and
`failed` (we tried and the model errored). The nightly backfill cron
(`/api/v1/cron/ocr-backfill`) treats `empty` as success.

**Env vars:**
- `PLEXO_VISION_URL` — base URL of the Plexo Vision sidecar. Required
  for the PaddleOCR path; if unset, OCR falls back to LLM (when
  `OCR_LLM_FALLBACK=true`) or is recorded as `failed`.
- `OCR_LLM_FALLBACK` — `false` by default; `true` retains the legacy
  LLM path as a backup.
- `OCR_DEFAULT_LANG` — defaults to `en`.
- `OCR_BACKFILL_BATCH_SIZE` — nightly cron batch size, default `50`.
  Clamped to `1..500` per call.

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

## RAW and HEIC support

Fonto decodes both Apple HEIC/HEIF and the major camera-RAW formats so the
grid and detail views render real thumbnails — not a broken-image
placeholder — for the half of a real photo library that isn't JPEG.

**Supported formats:**

| Format | Source | Decoder |
|---|---|---|
| HEIC / HEIF / AVIF | iPhone, Android | `sharp` (libvips with bundled libheif) |
| HEIC fallback | (when libheif missing) | `heif-convert` subprocess |
| CR2 | Canon DSLR / older mirrorless | `dcraw_emu -e` embedded JPEG |
| CR3 | Canon recent mirrorless (R / M50 / 90D+) | `dcraw_emu -e` embedded JPEG |
| DNG | Adobe / Pixel / Leica | `dcraw_emu -e` embedded JPEG |
| ARW / SRF / SR2 | Sony | `dcraw_emu -e` embedded JPEG |
| NEF / NRW | Nikon | `dcraw_emu -e` embedded JPEG |
| RW2 | Panasonic | `dcraw_emu -e` embedded JPEG |
| ORF | Olympus / OM System | `dcraw_emu -e` embedded JPEG |
| RAF | Fujifilm | `dcraw_emu -e` embedded JPEG |
| PEF | Pentax | `dcraw_emu -e` embedded JPEG |
| SRW | Samsung | `dcraw_emu -e` embedded JPEG |
| X3F | Sigma Foveon | `dcraw_emu -w` demosaic fallback |

For RAW we always try the **embedded preview JPEG first** (every modern
camera ships one — it's what the LCD displays and what Lightroom uses for
its "Embedded" preview; fast and high-quality). If extraction fails or the
file has no embedded JPEG, we fall back to `dcraw_emu -w` which demosaics
the raw sensor data to a 16-bit TIFF (slower, ~1-3s per shot, but always
works for any LibRaw-supported camera).

**Worker image dependencies:** the `fonto-worker` container installs
`libheif`, `libheif-tools`, `libraw`, `libraw-tools`, and `exiftool` from
Alpine packages. The sharp prebuilt binary already bundles libheif via
its libvips dependency (`@img/sharp-libvips-linuxmusl-x64`), so HEIC works
out of the box; the apk packages are belt-and-braces and provide the
`heif-convert` CLI used as a fallback.

**EXIF on RAW:** `lib/exif.ts` uses `exifr` which natively reads CR2 / ARW
/ NEF / DNG / NRW / ORF / RAF / PEF / RW2. The two formats exifr can't
parse (Canon CR3 and Sigma X3F) fall back to an `exiftool` subprocess;
if exiftool isn't installed we degrade silently to empty EXIF rather than
failing the upload.

**Tuning:**
- `RAW_DECODE_TIMEOUT_MS` (default 30000) — kill threshold per RAW or HEIC
  decode subprocess. Lower this if you'd rather drop the thumbnail than
  let a pathological file pin a worker for half a minute.

**License note:** libraw is LGPL and dcraw is public domain. We invoke
them as subprocesses (`dcraw_emu`) rather than linking — keeps Fonto's
AGPL-3.0 license uncontaminated.

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
- `fonto_asset_processing_duration_seconds{outcome=success|failure|paddle|llm-fallback|empty|skip}` —
  histogram of the full post-upload pipeline (classification, OCR, tags).
  `success`/`failure` are recorded once per pipeline run; the OCR sub-step
  emits an additional observation with `outcome=paddle` (PaddleOCR
  succeeded), `llm-fallback` (the legacy LLM path produced the text),
  `empty` (model ran but found no text), `skip` (no OCR provider available),
  or `failure` (model errored).
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

## API Documentation

Fonto's REST API is described by a [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document generated at runtime from the same Zod schemas used for request validation. Two surfaces are exposed:

- **`/docs/api`** — interactive [Scalar](https://scalar.com/) reference UI. Try requests against your running instance straight from the browser.
- **`/api/v1/openapi.json`** — raw spec, suitable for `openapi-generator`/`oapi-codegen`/etc. to produce typed clients.

Authentication is documented in the spec via three schemes: session cookie (web client), `Authorization: Bearer fonto_pat_...` (personal access token), and the equivalent `x-api-key` header. PATs land with Phase 2.1.

If you add a `/api/v1/*` route, register it in `lib/openapi/routes.ts`. The `scripts/check-openapi-coverage.ts` script diffs the registry against the filesystem; run it with `tsx scripts/check-openapi-coverage.ts`.

## Webhooks

Fonto can POST signed JSON payloads to your endpoints when workspace state
changes. Manage subscriptions at **Settings → Webhooks** in the app, or via
the REST API:

- `GET    /api/v1/webhooks` — list workspace endpoints
- `POST   /api/v1/webhooks` — create endpoint (returns `signingSecret` once)
- `PATCH  /api/v1/webhooks/:id` — update `url` / `enabledEvents` / `description` / `enabled`
- `DELETE /api/v1/webhooks/:id` — delete endpoint
- `POST   /api/v1/webhooks/:id/test` — enqueue a synthetic `ping` event
- `GET    /api/v1/webhooks/:id/deliveries?limit=50` — recent delivery log

### Event types

| Event | Fires when |
|---|---|
| `asset.uploaded` | A new asset row is inserted (post-dedup). |
| `asset.processed` | The asset-processing pipeline finishes (classification + description). |
| `asset.deleted` | An asset is soft-deleted or purged. |
| `tag.created` | A new tag is created in the workspace. |
| `collection.created` | A new collection is created. |
| `collection.shared` | A collection is shared via a public link. |

Every payload is wrapped in a stable envelope:

```json
{
  "id": "<uuid>",
  "type": "asset.uploaded",
  "createdAt": "2026-05-22T17:00:00Z",
  "data": { /* event-specific shape, see lib/webhooks/events.ts */ }
}
```

### Signature verification

Each POST carries three headers:

- `X-Fonto-Event` — the event type (e.g. `asset.uploaded`)
- `X-Fonto-Delivery` — the delivery row id (use for idempotency on your side)
- `X-Fonto-Signature` — `t=<unix>,v1=<hex_hmac>` (Stripe-style)

The HMAC is `SHA-256("{timestamp}.{raw_body}")` keyed by the endpoint's
signing secret. Always compare in constant time.

**Node.js:**

```js
import { createHmac, timingSafeEqual } from "crypto";

function verifyFontoSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=", 2))
  );
  const ts = parseInt(parts.t, 10);
  const sig = parts.v1;
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Python:**

```python
import hmac, hashlib, time

def verify_fonto_signature(raw_body: bytes, header: str, secret: str,
                           tolerance_sec: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    try:
        ts = int(parts["t"])
        sig = parts["v1"]
    except (KeyError, ValueError):
        return False
    if abs(time.time() - ts) > tolerance_sec:
        return False
    expected = hmac.new(
        secret.encode(),
        f"{ts}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, sig)
```

### Retry schedule

If a delivery returns a non-2xx status or times out (default 10s), Fonto
retries with exponential backoff: **1 min, 5 min, 15 min, 1 h, 6 h**.
Attempts cap at 6 total; after that the row is marked `failed` and no further
retries fire. Subscribers should respond with `2xx` as quickly as possible —
do heavy work asynchronously after acknowledging.

### Security notes

- **Always verify the signature.** A leaked URL alone shouldn't let anyone
  forge events.
- **Always check the timestamp tolerance.** Without it, a replayed body is
  indistinguishable from a fresh one. 5 minutes is a reasonable default.
- **Use `crypto.timingSafeEqual` / `hmac.compare_digest`.** String `==` on
  HMACs leaks timing information.
- **Treat `X-Fonto-Delivery` as an idempotency key.** Retries reuse it, so
  your handler can deduplicate.
- **Pin to HTTPS** for endpoint URLs in production.

## Folder view

Fonto preserves the source directory tree of your uploads so you can browse
by folder, Immich-style, without giving up everything else (timeline, smart
collections, etc.). Folders are **virtual** — they're computed at read time
from a single `directory_path text` column on `assets`; there is no folders
table.

**Capturing the path on upload** — three sites accept a directory:

- **Multipart `POST /api/v1/assets`** — send `X-Fonto-Path: /Photos/2024`.
- **Presigned `POST /api/v1/assets/init`** — include `"path": "/Photos/2024"`
  in the JSON body. It's persisted on the `asset_uploads` row and copied
  into the asset when `/complete` fires.
- **tus `/api/v1/uploads/tus`** — set `metadata.path` on your `tus-js-client`
  upload (tus encodes metadata as Upload-Metadata).

Paths are normalised server-side via `lib/folders/normalize.ts`: leading
slash, no trailing slash, no `..` segments, `\` → `/`, max 1024 chars. If
the last segment matches the upload filename it's stripped (so clients can
pass either a directory or a full file path).

**Listing folders** — `GET /api/v1/folders?prefix=/Photos` returns:

```json
{
  "prefix": "/Photos",
  "folders": [
    { "name": "2024", "path": "/Photos/2024", "assetCount": 412 },
    { "name": "2023", "path": "/Photos/2023", "assetCount": 308 }
  ],
  "assetsAtThisLevel": 4
}
```

Empty/omitted `prefix` lists top-level folders. The folder grid in the web
UI lives at `/app/folders` (see the sidebar **Folders** entry).

**Backfilling legacy uploads.** Older tools sometimes packed the relative
path into the `filename` column itself (`Photos/2024/IMG_0001.jpg`). Run
`pnpm backfill:folders` to split those rows: directory portion → normalised
`directory_path`, basename → `filename`. Idempotent (skips rows that already
have a path).

## Delta sync

Fonto exposes cursor-based delta sync so clients (mobile, CLI, third-party) can
catch up after being offline without refetching the whole library each wake.

Endpoints (all `GET`, return `{ entries, nextCursor, hasMore }`):

- `/api/v1/sync/assets?cursor=<seq>&limit=500`
- `/api/v1/sync/tags?cursor=<seq>&limit=500`
- `/api/v1/sync/collections?cursor=<seq>&limit=500`

**Cursor semantics.** Every syncable entity carries a monotonic per-workspace
`seq bigint`. Each call returns rows with `seq > cursor` ordered by seq ASC.
The response's `nextCursor` is the highest `seq` returned; the client persists
it and sends it back next call. A missing/empty cursor means "from the start".
Cursors are decimal strings (bigint), non-negative; anything else returns 400.

**Page sizes.** `limit` defaults to 500, max 1000. `hasMore: true` means more
rows likely exist beyond this page; keep calling with the new cursor until
`hasMore` is false.

**Tombstones.** Deleted assets show up as `{ op: 'delete', id, seq }` entries
once `deleted_at` (trash) or `purged_at` (hard delete) is set. The full asset
row is **not** included for tombstones — only the id. Upserts use
`{ op: 'upsert', seq, asset: { ... current state ... } }`.

**Compacted, not historical.** A client offline for months sees the latest
state of each row, not every intermediate write. Each row appears at most
once per sync window — at its current seq.

**What bumps an asset's seq.** Creation, lifecycle change (trash/restore/
archive/purge), share-link create/revoke (share state is visible to the
client), and favorite/rating changes. Internal fields that the client
never sees (e.g. internal queue attempt counters) do not bump seq.

## Library UX

### Favorites and ratings

Every asset carries a binary favorite (heart) and a 0..5 star rating, both
editable from the lightbox top toolbar. 0 means "unrated"; the badge on the
grid only appears for `rating > 0`. The favorite shows as a small heart in
the corner of the grid card whenever it's set.

**Keyboard shortcuts** (active while the lightbox is open and no text input
has focus):

| Key  | Action                |
|------|-----------------------|
| `F`  | Toggle favorite        |
| `1`–`5` | Set rating (1..5)   |
| `0`  | Clear rating           |

The updates are optimistic — the heart and stars flip immediately, the
`PATCH /api/v1/assets/{id}` fires in the background, and the UI reverts only
if the request fails.

**Filtering the timeline.** The chip row above the grid has two facet chips,
"Favorites" and "Rated 4+". They stack on top of the mime filter (Photos /
PDF / Text). Server-side they map to `?favorite=1` and `?ratingMin=4` on
`GET /api/v1/assets`.

**Smart collections.** The smart-collection query DSL accepts two new
top-level keys that AND with everything else in the saved query:

```json
{
  "favorite": true,
  "ratingMin": 4,
  "conditions": [{ "field": "mimeType", "op": "startsWith", "value": "image/" }]
}
```

Both columns are indexed with partial BTrees (`is_favorite = true`, `rating > 0`)
so the predicates are cheap even on large libraries.

## pgvector

Vector data — CLIP image embeddings (Phase 4), ArcFace face embeddings
(Phase 5), and eventually pHash recast as a dense vector — lives in the
same `postgres` instance as every other Fonto table, via the
[`pgvector`](https://github.com/pgvector/pgvector) extension. There is no
separate vector store. See `docs/adr/0002-pgvector-not-falkordb.md` for
the rationale; the short version is that `WHERE workspace_id = $1 AND
lifecycle_state = 'active' ORDER BY clip_vec <=> $2 LIMIT 50` is a single
index scan in Postgres and a cross-store join everywhere else.

**Prerequisite.** The `vector` extension must be installable on
`DATABASE_URL`. The shared `postgres` cluster has it; bare Postgres
needs `apt-get install postgresql-NN-pgvector` on the host before
migrations run. Probe at runtime:

```bash
curl -fsS http://localhost:3500/api/health?check=vector
# {"ok":true,"check":"vector","timestamp":"..."}
# 503 + a hint string if the extension isn't installed.
```

**Schema.** Migration `0017_pgvector_setup.sql` runs
`CREATE EXTENSION IF NOT EXISTS vector`, adds `fonto.assets.clip_vec
vector(512)`, and creates the partial HNSW index:

```sql
CREATE INDEX assets_clip_vec_hnsw_idx
  ON fonto.assets
  USING hnsw (clip_vec vector_cosine_ops)
  WHERE clip_vec IS NOT NULL;
```

**HNSW vs IVFFlat.** We chose HNSW. It has higher build cost than IVFFlat
but lower query latency at the recall floor we care about for
text-to-image search. pgvector's defaults (`m = 16`,
`ef_construction = 64`) are reasonable for libraries up to a few million
vectors per workspace; revisit if recall slips. The index is partial
(`WHERE clip_vec IS NOT NULL`) so it stays small until Phase 4.2 starts
backfilling embeddings.

**Migration order.** Apply `0017` **before** Phase 4.2's CLIP backfill —
without the column the backfill writer has nowhere to put its output.
On a large existing assets table `CREATE INDEX ... USING hnsw` can take
hours; the build is safe to run on a live table (pgvector handles
concurrent writes during the build), but plan a maintenance window if
the library is sizeable.

**Reading.** `lib/vectors/nearestNeighbors(workspaceId, queryVec, limit,
threshold?)` runs the cosine kNN scan and returns
`{ assetId, similarity }[]`. `lib/vectors/cosineSimilarity(a, b)` is the
pure-JS equivalent for re-ranking or sanity checks.

**FalkorDB retirement.** `lib/fonto-graph.ts` used to mirror pHashes into
a FalkorDB sidecar for vector kNN. ADR 0002 retires that path. The
module is now a stubbed no-op (every export returns `false` / `null`)
kept for binary compatibility while the call sites in
`lib/assets/createAssetRow.ts` get cleaned up in a follow-up PR.

## Auto-classification

Every image is classified into a top-level category (`photo`, `document`,
`screenshot`, `meme`, `art`, `screenshot-receipt`, `id-card`, `cover-art`,
`whiteboard`) and, where applicable, a sub-category (e.g. `food`, `portrait`,
`pets`). The classification is written to `assets.classification` and the
sub-level to `assets.sub_classification`. Sub-categories also carry a small
set of curated tag suggestions, which land as `ai_suggested = true` rows in
the `tags` table.

**How it works.** Two paths exist:

1. **Zero-shot CLIP** (the cheap path). Every taxonomy prompt is embedded
   once at boot via the Plexo vision service and cached on disk at
   `~/.fonto/classify-vectors.json` (override with
   `CLASSIFY_VECTOR_CACHE_PATH`). Classification is then a cosine-similarity
   argmax against the image's CLIP embedding — ms-scale, free.
2. **LLM fallback** (the smart path). When the top-1 cosine falls below
   `CLASSIFY_CONFIDENCE_THRESHOLD` (default `0.18`), or when the gap to
   the runner-up is < 0.05, we defer to the vision-LLM classifier
   (`plexoClassifyAsset`). Slower (~1-3s) and costs tokens (~$0.001/image)
   but reliably better when CLIP is uncertain. Per ADR 0001 this is the
   one case where the LLM is genuinely worth its cost.

`assets.classify_method` records which path ran (`"clip"` or
`"llm-fallback"`); `assets.classify_confidence` records the top-1 cosine
(or 0 for the LLM fallback path); `assets.auto_tagged_at` stamps each
successful auto-tag pass.

**Tuning the threshold.** The Prometheus histogram
`fonto_zero_shot_confidence_buckets` records the top-1 cosine for every
classify attempt — including the ones that took the LLM fallback. If most
mass sits below `0.18`, you're sending too much to the LLM; consider
lowering the threshold (`CLASSIFY_CONFIDENCE_THRESHOLD=0.15`) once you've
spot-checked a few low-confidence classifications and they look reasonable.

**Extending the taxonomy.** Edit `lib/classify/taxonomy.ts` — add a new
top-level `TopCategory` or a new `SubCategory` under an existing one
(with a CLIP prompt and tag-suggestion list). Delete
`~/.fonto/classify-vectors.json` to force a re-embed on next boot. Taxonomy
keys are intentionally stable across deploys — the rest of the codebase
(document-event triggers, receipt detection, smart-collection chips)
relies on them.

**Smart-collection facets.** The smart-collection DSL accepts
`{ "subClassification": "food" }` and `{ "classifyMethod": "clip" }` as
top-level keys (alongside `favorite` and `ratingMin`). Both AND with the
user's other conditions.

**ML-enriched smart-collection facets (Phase 5.4).** Four more top-level
keys, all AND-ed with everything else:

```json
{
  "clipText": "dog on beach",
  "personIds": ["3f0a…", "b211…"],
  "hasFaces": true,
  "dominantColor": "#ff5500",
  "tolerance": 30
}
```

- `clipText` embeds the text via the Plexo vision sidecar (cached
  per-process for `CLIP_TEXT_CACHE_TTL_MS`, default 1 h) and intersects
  the saved query with the top 200 nearest-neighbour matches from
  `assets.clip_vec`. If `PLEXO_VISION_URL` is unset, the clause is
  silently dropped — every other condition still applies.
- `personIds` / `hasFaces` depend on the Phase 5.1 `face_instances`
  table; until 5.1 ships the clauses are no-ops (do not error, do not
  filter).
- `dominantColor` compares the asset's top palette entry (from
  `assets.colors`, populated by the Phase 0 pHash worker) against the
  target hex using CIE76 ΔE in Lab space. `tolerance` is in ΔE units
  (default 30 ≈ "same hue family").

**Graceful degradation.** If the vision service is unreachable at boot,
every image takes the LLM-fallback path. If the LLM is also unavailable,
the worker falls back to a MIME-based heuristic (`image/*` → `photo`,
everything else → `document`). Uploads + search never break.

## Audit log

Every mutating action a user performs against a workspace (asset uploads,
updates, deletions; share-link creation and revocation; token mints and
revocations; webhook CRUD; settings changes) is recorded to the
`fonto.audit_log` table by `lib/audit.ts`'s `recordAuditEvent()` helper.

Audit writes are **strictly fire-and-forget** — the helper swallows every
error and logs a `component=audit.write` pino line on failure. Audit logging
will never break a request path.

**Privacy.** Raw client IPs are NEVER stored. The helper truncates IPv4 to
/24 and IPv6 to /48 before writing. User-Agent strings are capped at 500
characters. The full retention contract lives in ADR 0007.

**Retention.** Rows older than `AUDIT_RETENTION_DAYS` (default 90) are
deleted by a daily BullMQ maintenance job (`prune-audit-log`, registered
in `worker/index.ts` alongside the stuck-asset reaper). The interval is
configurable via `AUDIT_PRUNE_INTERVAL_MS` (default 24 h).

**Viewing.** Workspace owners can browse the last 200 events in their
workspace at `/app/settings/audit`, optionally filtered by action. There
is no CSV/JSON export by design — the log lives in the admin UI only.

## CLIP search

Fonto can answer "find me a dog on a beach" without anyone having tagged
those photos. Phase 4.2 wires the search UI to an OpenCLIP (ViT-B/32 by
default) image encoder hosted by the Plexo `apps/vision` service. Image
embeddings are computed once at upload time, written into
`fonto.assets.clip_vec` (pgvector), and queried with cosine similarity at
search time after the user's text query gets its own CLIP text embedding.

### What gets indexed

- Every image asset (any `image/*` MIME type) at upload. The worker prefers
  the 1080px preview derivative — small, web-safe, already decoded by
  sharp — over the original to keep vision-service load reasonable.
- Existing images can be embedded retroactively with `pnpm backfill:clip`
  (idempotent; only touches rows where `clip_vec IS NULL`).
- Non-image assets are skipped silently. PDFs/text still fall through the
  text + OCR search path.

### Querying

- `GET /api/v1/search/clip?q=dog+on+beach&limit=50` — returns
  `{ results: [{ asset, similarity }] }` sorted by cosine similarity
  descending.
- `POST /api/v1/search/clip` with `{ q, limit, workspaceId? }` — same
  behaviour, JSON body. Useful for long natural-language queries that don't
  URL-encode cleanly.
- The web search page automatically fires a CLIP query alongside the text
  search when the typed query "looks natural" (>3 words, or contains a
  visual verb like "show", "wearing", "near"). Semantic hits render under
  the text results as a "Visually similar" section.

### Query language

The query is free text. CLIP was trained on alt-text-style captions, so it
likes phrases that describe a scene: "person in a red coat", "screenshot
of a terminal", "logo on a white background". One- or two-word queries
work but are noisier — prefer the existing filename/OCR text search for
exact-string lookups.

### Prerequisites

- The Plexo vision sidecar (`apps/vision` in the platform repo) must be
  reachable at `PLEXO_VISION_URL` (default `http://plexo-vision:7000`).
  Without it, the search route returns `{ results: [], unavailable: true }`
  and the embed worker no-ops — uploads still work; semantic search is
  simply absent.
- `PLEXO_SERVICE_KEY` is reused as the vision service auth bearer.
- The pgvector extension and `fonto.assets.clip_vec` column must exist
  (lands in Phase 4.3 migration 0017). Until then `clip_vec` writes throw
  cleanly and the worker logs a "phase 4.3 not landed" skip.

## Memories (On this day)

Phase 5.3 surfaces a per-day flashback view: every asset whose EXIF capture
date matches today's MM-DD (±N days) in prior years, grouped by year. The
dashboard renders a horizontal carousel (one tile per prior year, click to
open the full grid); the dedicated page at `/app/memories` exposes a date
picker so you can navigate to any day.

Backed by `GET /api/v1/memories?date=YYYY-MM-DD` (default: today). The
query relies on a functional partial index added in migration 0023
(`assets_workspace_captured_mmdd_idx`) so it stays cheap as the library
grows; without it Postgres falls back to a seq scan on the whole
`fonto.assets` table.

Two knobs in `.env.example`:

- `MEMORIES_DAY_WINDOW` (default `3`) — days of fuzz around the target
  date. Set `0` for exact MM-DD only.
- `MEMORIES_MAX_PER_YEAR` (default `50`) — per-year cap on the returned
  list, applied after the SQL `LIMIT 200`. Prevents a single high-volume
  day from dominating the carousel.

Memories only includes `lifecycle_state = 'active'` assets with a non-NULL
`captured_at`, and only years strictly before the current calendar year (so
"this year" never appears in the flashback). Wrap-around across month
boundaries (Dec → Jan) is intentionally not handled in V1.

A future v2 will cluster results by CLIP similarity inside 24h windows
("trip to Iceland day 3" instead of "47 photos from 2023-05-23") — see the
`TODO(v2)` in `app/api/v1/memories/route.ts`.

## Map / GPS / reverse geocoding

Phase 5.2 surfaces every geo-tagged asset on an interactive map (MapLibre GL
JS + OpenStreetMap raster tiles + supercluster for client-side hierarchical
clustering). The page lives at `/app/map`; on every viewport change it
debounces (350 ms) and refetches `/api/v1/assets/within-bbox`.

Each asset row carries a reverse-geocoded `place_name` (`"Reykjavík, IS"`)
derived from `(latitude, longitude)` via the offline **GeoNames cities500**
dataset (every populated place with ≥500 residents, ~190k entries, ~9 MB
uncompressed TSV — see `lib/geocoder.ts`). The lookup uses a `kdbush`
spatial index built once per process and cached; the lookup is `O(log n)`
plus a haversine scan over the bbox-filtered candidates.

The repo only ships a ~50-line placeholder of the dataset so the geocoder
code path runs in CI / local dev without committing 9 MB of TSV. **Before
the first production deploy, materialise the full file:**

```bash
pnpm tsx scripts/fetch-geonames.ts
```

That downloads `cities500.zip` from `download.geonames.org`, unzips it into
`data/geonames/cities500.tsv`, and is idempotent (re-running overwrites in
place). The script needs `unzip` on PATH (Alpine: `apk add --no-cache
unzip`). Bake it into the production Dockerfile or the first-boot init step
of the deployment.

GeoNames is **CC-BY-4.0**; the map page renders the required OSM tile
attribution in the footer. If you swap the tile source, swap the
attribution string in `app/(app)/app/map/page.tsx` to match.

**Backfill existing assets** (idempotent — only touches rows with GPS but no
`place_name`):

```bash
pnpm backfill:places
pnpm backfill:places -- --batch=50 --dry-run
```

Run it again after a future cities500 refresh — the WHERE clause picks up
rows the previous pass left unmatched (e.g. mid-ocean photos that suddenly
match a new tiny island entry).

## Stacks

Phase 5.5 groups related assets — RAW+JPEG of the same shot, an iPhone burst,
multiple edits of the same photo — into a "stack" where one member is the
**primary**. The timeline shows only the primary; clicking opens the lightbox
which surfaces a "Stack of N" badge in the bottom-left corner. Click the
badge to expand an inline carousel of every member.

**Manual creation.** Suggestions are read-only — the auto-suggester at
`GET /api/v1/stacks/suggestions` flags candidate clusters but never creates
stacks on your behalf. Accept a suggestion via
`POST /api/v1/stacks/suggestions/accept`, or create one from scratch via
`POST /api/v1/stacks` with a `{ assetIds, primaryAssetId, name? }` body.

**Two heuristics**, configured per-deploy in `.env.example`:

| Heuristic   | Rule                                                                                              | Window env var               |
|-------------|---------------------------------------------------------------------------------------------------|------------------------------|
| `raw+jpeg`  | Two assets from the same camera (matching `cameraMake`/`cameraModel`), one `image/jpeg` + one canonical RAW (CR2/CR3/DNG/ARW/NEF/etc — see `lib/mime.ts:RAW_MIME_TYPES`) within `STACK_RAW_JPEG_THRESHOLD_S` seconds of each other. | `STACK_RAW_JPEG_THRESHOLD_S` (default `2`) |
| `burst`     | 3+ assets from the same camera within `STACK_BURST_THRESHOLD_S` seconds of each other. Pairs are intentionally skipped — they're more likely an intentional double than a burst. | `STACK_BURST_THRESHOLD_S` (default `5`)   |

Bursts win over raw+jpeg when both would surface overlapping assets: if a
4-shot burst happens to contain a RAW+JPEG pair, the burst suggestion covers
it and the pair is suppressed.

**Timeline filter.** `GET /api/v1/assets` defaults to primary-only:
non-primary stacked members are hidden. Pass `?expandStacks=true` (or `=1`)
to opt in to "show every asset" mode. The filter uses a correlated subquery
over `fonto.stacks`, indexed by both the partial
`assets(workspace_id, stack_id) WHERE stack_id IS NOT NULL` and
`stacks(primary_asset_id)`.

**Smart-collection compatibility.** By default smart collections respect the
same primary-only stack filter so a burst of 12 surfaces as one match, not
twelve. The DSL extension `{ "expandStacks": true }` opts in to the
"every member is a match" mode — useful for power-user collections like
"all RAW originals":

```json
{
  "expandStacks": true,
  "conditions": [{ "field": "mimeType", "op": "startsWith", "value": "image/x-" }]
}
```

**Lifecycle.** Removing the primary from a stack promotes the next-oldest
member (by `capturedAt`, falling back to `createdAt`) to primary. Removing
the last member deletes the stack row entirely. `DELETE /api/v1/stacks/:id`
un-stacks every member then drops the stack row in one call.

## Built on Plexo

Fonto is a [Plexo](https://getplexo.com) App Profile. Asset classification, tag suggestions, and image description all route through Plexo's model gateway. Plexo also adds persistent memory — Fonto remembers tag preferences and classification corrections across sessions. See `lib/plexo.ts` and `lib/plexo-registration.ts` for the integration surface.

## License

[AGPL-3.0-only](./LICENSE) — Copyright (C) 2026 Joeybuilt LLC.

If you modify Fonto and run it as a network service, you must share your modifications under the same license. For commercial use without copyleft obligations, contact us.
