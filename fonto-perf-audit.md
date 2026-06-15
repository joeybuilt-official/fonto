# Fonto Performance Audit & Speed Optimization Plan

**Status:** Read-only audit, plan only. **No code, schema, config, or dep changes made.**
**Branch:** main (HEAD `1d184de`)
**Date:** 2026-06-15
**Stack confirmed:** Next 16.2.1 / React 19.2.4 / Drizzle / postgres-js + pg (pushd Postgres) / ioredis (Valkey) / R2 via @aws-sdk / sharp / @tanstack/react-virtual

## Stack deltas vs spec
| Spec said | Actual |
|---|---|
| Next 15 | **Next 16.2.1** |
| Supabase | **None.** Postgres direct via postgres-js + pg, shared pushd DB, `fonto` schema |
| Inngest | **None.** BullMQ on Valkey, 12 queues + tsx worker harnesses + autoscaler |

## Deployment hops

```
client
  → Cloudflare edge (cache + Access)
  → tunnel-daemon tunnel (currently http2-forced; UDP/QUIC blocked at edge)
  → NAS (Linux NAS, 127.0.0.1)
    → fonto       (Next.js server, port 3000)
    → fonto-worker × 3 replicas (BullMQ worker processes)
    → postgres  (shared pushd; `fonto` schema)
    → service      (queue + rate-limit + CLIP-text LRU)
  → R2 (Cloudflare object storage) for originals + derivatives, presigned 1h URLs
  → Plexo (sidecar, vision/embeddings/face) via @joeybuilt/plexo-sdk
```

Notable: tunnel-daemon was swapped to http2 protocol earlier today after QUIC dial began failing at the edge. Latency floor for tunnel transport went up modestly but is now stable.

---

## Layer-by-Layer Cache Inventory

| Layer | Present? | Config | What it caches | TTL / invalidation | Gap |
|---|---|---|---|---|---|
| **Cloudflare edge** | Partial | Per-route `Cache-Control` headers | Derivative URLs (`/api/v1/assets/[id]/url`, 1h `public`), batch presign (`/urls`, 1h `private`), HLS playlist (60s `private`), HLS segments (300s `private,immutable`), OpenAPI (5m `public`), assetlinks (1h `public`) | TTL only; no `revalidateTag`/path | No Page caching (SSR all dynamic). No CF Cache Rules for static asset routes. No PPR. |
| **Next.js Data Cache** | Effectively off | `export const dynamic = "force-dynamic"` on **49 of 49** `/api/v1/*` routes | Nothing | n/a | Total adoption of `force-dynamic` removes fetch dedupe + request coalescing entirely. Zero `unstable_cache` / `revalidateTag` / `cacheTag` usage. Next 16 `cacheComponents` unused. |
| **React `cache()` per-request** | No | — | — | — | `getAuthUser()`, `getUserWorkspaces()` not wrapped → same request runs both multiple times across server components + route handler boundaries. |
| **Valkey / ioredis** | Yes (queue + 2 small caches) | `lib/queue/connection.ts` singleton, `redis://valkey:6379`, no TLS, `maxRetriesPerRequest:null` for BullMQ | 12 BullMQ queues (asset-processing, thumbnails, classify, ocr, clip-embedding, clip-dedup-check, face-detect, video-hls-transcode, webhook-delivery, import, storage-sync, extract-evidence, maintenance); share-link rate-limit (`sharelink:rate:{ipHash}`, 60s); CLIP-text LRU **in-process** (`lib/vectors/clipTextCache.ts`, 100 entries, 1h, not in Valkey) | TTL or BullMQ retention (1000 jobs / 14d dead-letter) | **Valkey is essentially unused for read caching.** No cache of search results, person/face cluster manifests, thumbnail manifests, smart-collection compiled ASTs, signed-URL batches. CLIP-text cache is per-pod (lost on restart, no sharing across workers). No stampede lock. No hit/miss metrics. |
| **Postgres (pushd `fonto`)** | Indexes mostly correct | `lib/db/schema.ts:91-389` for assets (45+ cols, 25 indexes) | — | — | See "Index Gaps" below. Two single-column indexes risk seq scans; no read-replica; pool is **unbounded** on the main DB driver. |
| **R2** | Long-tail correct | Derivatives written with `Cache-Control: public, max-age=31536000, immutable` | Eager 256px thumb + 1080px preview, content-addressed keys | Immutable | Only 2 fixed sizes, no responsive tiers, WebP-only no AVIF/JPEG fallback, no progressive JPEG, no blurhash. |

---

## Hot-Path Findings (evidence-based)

### HP-A. Library / bookmarks grid first paint

**Chain (per `/app` first paint):**
1. middleware.ts (cheap, no auth check, just public-prefix gate + Phase-5 redirect map)
2. server component → `getAuthUser()` → better-auth `auth.api.getSession({ headers })` → **DB hit to pushd `auth` schema** (`lib/auth/server.ts:50` and `lib/auth.ts:6-14`, dedicated `pg` Pool `max:10`)
3. server component → `getUserWorkspaces()` → 1 more DB hit
4. GET `/api/v1/assets/buckets` (month-bucket counts)
5. GET `/api/v1/assets?...` (keyset paged, 200/window)
6. `useBatchThumbUrls` → POST `/api/v1/assets/urls` (250 ids/chunk) → R2 presigns × N
7. Grid renders via `@tanstack/react-virtual`, overscan **4 rows** (`asset-grid.tsx:358`)

**Single biggest cost:** auth + workspace pair, **not deduped per request.** Better-auth's `getSession` hits Postgres every call and `getAuthUser` is called from middleware (cheap path), server components, AND route handlers in the same request → multiple round-trips for the same session. Ballpark **50–150 ms × N callsites** per page load. This is an **ACTUAL** latency cost (compute + I/O), not a perceived/skeleton problem.

Secondary: bucket query + assets query are sequential server-side (no `Promise.all`).

**Win class:** TTFB (auth dedupe) + LCP (thumbnail prefetch is already good — batch URL fetch in 250-chunks is correct).

---

### HP-B. Search

**Chain (`/api/v1/search`):**
1. `getAuthUser()` (same auth cost as HP-A)
2. GET `/api/v1/search?q=...&filters` — FTS `to_tsvector('english', extracted_text || ocr_text)` via `assets_ocr_text_fts_idx` (GIN). Color filter runs **JS-side after limit=500** (`app/api/v1/search/route.ts:89-94`) → re-filtered to 100 on the server.
3. If "semantic" heuristic fires (`>3 words` or visual verbs in query), parallel GET `/api/v1/search/clip?q=...&limit=24` → CLIP text embedding via Plexo vision sidecar → pgvector HNSW on `assets.clip_vec` (cosine `<=>`, partial index correctly used per migration `0017:44`).

**Single biggest cost:** the **CLIP path is gated by Plexo network latency** (~2–5 s typical). Text results render fast (~200–400 ms); the "Visually similar" rail blocks on Plexo. If Plexo is unreachable, current timeout is 30 s before lexical-only fallback. CLIP-text LRU absorbs repeats but only within one worker pod.

Secondary: no dedupe across (workspace_id + lifecycle_state) on the lexical query — see Index Gaps; partial composite index would let the planner avoid a bitmap merge.

**Win class:** LCP for semantic queries (Plexo round-trip), ACTUAL.

---

### HP-C. Single-asset lightbox

**Chain (lightbox mount, `photo-lightbox.tsx:616-708`):**
- GET `/api/v1/assets/[id]/url?variant=preview`
- GET `/api/v1/assets/[id]/faces`
- GET `/api/v1/assets/[id]/tags`
- GET `/api/v1/tags`            ← workspace-wide, fired per asset
- GET `/api/v1/collections`     ← workspace-wide, fired per asset
- GET `/api/v1/assets/[id]/share`
- Conditionally: OCR text endpoint for text-kind assets

**Single biggest cost:** **`/api/v1/tags` and `/api/v1/collections` re-fired on every asset-nav inside the lightbox** even though they are workspace-scoped invariants. Six sidecars × 50–150 ms = ~500–900 ms of metadata-panel LCP. The image itself (preview variant) renders quickly (1080px WebP, 1y immutable).

Secondary: no preload of next/prev asset preview on hover/focus in grid → first arrow-key advance through a stack takes a full preview-fetch round-trip.

**Win class:** LCP on metadata panel (sidecar dedupe), ACTUAL. Arrow-nav fluidity is PERCEIVED + ACTUAL.

---

### HP-D. Upload → grid-visible

**Chain (`NEXT_PUBLIC_DIRECT_UPLOAD=true` path):**
1. POST `/api/v1/uploads/presign` → 1h `PUT` URL minted, asset row created in `pending` state
2. Client PUT direct → R2
3. POST `/api/v1/uploads/{assetId}/complete` → SHA-256 dedup + enqueue `asset-processing` BullMQ job
4. Worker pipeline: classify → OCR/text → **thumbnail (sharp 256 + 1080, eager)** → CLIP embed → face detect
5. Storage-sync mirror to R2 paths under content-addressed key
6. Client polling or delta-sync cursor surfaces the asset in the grid once `lifecycle_state='active'` + `thumbnailKey IS NOT NULL`

**Single biggest cost:** **thumbnail derivative** is the long pole on the *grid-visibility* critical path (classify + thumb = 1.5–3 s under steady state, longer on HEIC/RAW). CLIP + faces add ~3–8 s but they're off the visibility path — the asset shows once the thumbnail is ready.

Secondary: presigned PUT to R2 is a fat-pipe operation; large RAWs can dominate.

**Win class:** ACTUAL (compute + I/O). Worker concurrency tuning + decoder selection (libheif/dcraw) is where the win lives.

---

### HP-E. Auth round-trip (every request)

**Chain (per route handler):**
1. `getAuthUser()` (`lib/auth/server.ts:50`) → better-auth `getSession({ headers })` → 1–5 DB queries depending on refresh logic
2. `getUserWorkspaces()` → 1 query

**Single biggest cost:** **no `cache()` wrapper.** A single request touching middleware + server component + route handler can hit the auth DB 3× for the same session. Better-auth has its own `Pool` (`max:10`, `idleTimeoutMillis:30_000`) — good — but the call is unconditional. ~50–150 ms per call × 3 = up to 450 ms of pure auth on a "hot" page load.

**Win class:** TTFB across every authenticated request, ACTUAL. Highest leverage / lowest risk in the whole audit.

---

## Index Gaps (Postgres `fonto`)

Source: migrations `0017_*`, `0021_*`, `0023_*`, `lib/db/schema.ts`.

| Concern | Where | Risk |
|---|---|---|
| `assets_lifecycle_state_idx` is single-column btree without `workspace_id` | `lib/db/schema.ts:~210` | All grid/search/timeline queries filter on both. Planner likely chooses bitmap-merge under load instead of an index-only scan. |
| No partial `(workspace_id, lifecycle_state) WHERE lifecycle_state='active'` | — | The 95th-percentile read path filters exactly on this. |
| Memories `captured_mmdd_utc(captured_at)` functional index | migration `0023:41` | Probably fine; needs `EXPLAIN ANALYZE` confirmation under prod traffic. |
| pgvector HNSW on `assets.clip_vec` | migration `0017:44`, partial `WHERE clip_vec IS NOT NULL` | Correct. No GiST/IVFFlat fallback (acceptable — HNSW is the right pick at this scale). |
| pgvector HNSW on `face_instances.embedding` | migration `0021:41` | Correct. |
| `postgres-js` main pool **unbounded** | `lib/db/index.ts:3-25` | Spike load → connection storm to pushd. Better-auth's pool is correctly bounded at 10. |
| No read-replica | — | Topology choice; flag for Tier 3 only if traffic justifies it. |

---

## Tiered Optimization Plan

Each item: **problem · fix · est impact · effort · risk · reversible?**
Cost classes: **L** (low) / **M** (moderate) / **H** (high); a "1-way door" is explicitly called out.

### Tier 1 — free / low-risk

| # | Problem | Fix (plan only — no code yet) | Impact | Effort | Risk | Reversible |
|---|---|---|---|---|---|---|
| T1.1 | Auth deduped per request | Wrap `getAuthUser()` + `getUserWorkspaces()` with React `cache()` (per-request memo). | **−100…−300 ms TTFB on every authenticated route** | L (≤30 lines) | L | Yes |
| T1.2 | `/api/v1/tags` + `/api/v1/collections` re-fired per lightbox asset | Hoist these fetches to lightbox parent + memoize; or React Query at the page level. | **−400…−700 ms metadata-panel LCP per asset-nav** | L | L | Yes |
| T1.3 | 49 routes force-dynamic with no need | Audit each `dynamic = "force-dynamic"`: keep on truly per-user/mutable routes (e.g. assets list with cursor), drop on workspace-scoped read endpoints that can use `revalidateTag('workspace:<id>:tags')` etc. | **Cuts cold-fetch path; allows dedupe** | M (per-route audit) | M (mis-tag = stale data) | Yes |
| T1.4 | Lightbox no hover-preload of preview | Add `<link rel="prefetch">` (or `Image.prefetch`) for next/prev preview URL on grid hover/focus. | **Arrow-nav from ~300 ms → ~30 ms perceived** | L | L | Yes |
| T1.5 | Composite index gap `(workspace_id, lifecycle_state)` | **Schema migration → flag as non-trivial per constraints. Surface for approval.** Recommend partial: `WHERE lifecycle_state='active'`. | **Removes the worst seq-scan risk; ~30–80 ms off hot grid queries** | L (one migration) | L | Yes (drop index) |
| T1.6 | postgres-js main pool unbounded | Set `postgres(url, { max: 20, prepare: false })` (config change, no schema). | **Prevents connection storm on traffic spike; latency under spike ≈ unchanged but reliability up** | L | L | Yes |
| T1.7 | Brotli on `/api/v1/assets/urls` batch responses | Ensure Next.js compress + Cloudflare brotli on this route (5000 ids × ~2 KB JSON = ~10 MB uncompressed worst case; brotli kills ~80%). | **−6…−8 MB on People grid first paint** | L | L | Yes |
| T1.8 | CLIP-text LRU is per-pod | Move to Valkey with same TTL + add stampede lock. | **Cross-pod hit rate up; semantic search cold start fewer Plexo calls** | L | L | Yes |
| T1.9 | No Valkey cache hit/miss observability | Wrap reads with counters → Prometheus gauges. | **Visibility (no perf delta yet)** | L | L | Yes |

### Tier 2 — moderate

| # | Problem | Fix (plan only) | Impact | Effort | Risk | Reversible |
|---|---|---|---|---|---|---|
| T2.1 | Search re-runs Postgres + Plexo with no dedupe | Cache search results in Valkey keyed by `(workspace, normalized_query, filters_hash)`, TTL 5–10 min, `tag='workspace:<id>:assets'`, evict on mutation events from worker. Includes stampede lock. | **Repeat queries: ~−200 ms (text) / −2…−4 s (semantic)** | M | M (stale results on rapid edits) | Yes |
| T2.2 | Workspace-scoped invariants (tags, collections, person clusters) refetched constantly | Same pattern — Valkey cache + tag-invalidation on mutation; UI-level React Query as L1. | **−50…−150 ms per request × dozens of callsites** | M | M | Yes |
| T2.3 | Grid lacks responsive srcset / format negotiation | Plan: produce 512px and 1024px tiers in the worker; emit `<img srcset>` + `sizes` from `PhotoCard`; add AVIF alongside WebP (sharp `effort=4` → ~25% smaller than WebP). Skip JPEG fallback (every Fonto-supported client speaks WebP). Storage cost on R2 ≈ 2.2× current derivatives. | **−40…−60% bytes on hi-DPI mobile grid; LCP −200…−400 ms** | M (worker pipeline change + backfill) | M | Partial — backfill is async and idempotent |
| T2.4 | No blurhash / LQIP on grid | Compute 4×4 average colour + serialize to short string at thumbnail time; render `<div style={{background:...}}>` under `<img>`. Tiny CPU cost in worker, no extra R2 object. | **CLS −10…−30 points on fast scroll; PERCEIVED LCP improves visibly** | M | L | Yes |
| T2.5 | List view overscan = 10 items wastes DOM on dense lists | Reduce to 5 on `density='compact'`; raise to 12 on `density='comfortable'`. | **−DOM cost on low-end mobile** | L | L | Yes |
| T2.6 | Worker pipeline runs classify→thumb sequentially | Reorder: kick thumbnail in parallel with classify so grid visibility doesn't wait on classify. Classify still gates lens facets but those are post-paint. | **Upload→grid-visible: −500…−1500 ms** | M | M (need to verify nothing reads kindClassified before thumb is generated) | Yes |
| T2.7 | HLS 60-second cache vs live edge | If product wants live edge: drop playlist cache to 5–10 s or use no-store on the live playlist while keeping segment immutable. | Niche — only matters when video is live | L | L | Yes |
| T2.8 | No PPR / cacheComponents (Next 16 features) | Pilot on one page (e.g. People grid) — static shell + dynamic islands. | **TTFB on initial nav from server-side −150…−250 ms** | M | M (Next 16 PPR still maturing in this repo) | Yes |

### Tier 3 — structural (requires ADR + expert-panel sign-off)

| # | Problem | Fix proposal | Reversibility |
|---|---|---|---|
| T3.1 | **Asset delivery architecture** — every derivative is proxied through Next + presigned. R2 has a public-bucket / Cloudflare-Worker-routing alternative that can serve thumbnails directly from R2 with edge caching, gated by signed-token-in-querystring (no Next round-trip at all). Would slash thumbnail latency outside the LAN and offload CPU. | New ADR: signed-token-in-querystring delivery via Cloudflare Worker fronting R2, with the existing `/api/v1/assets/[id]/url` becoming a fallback for private/face/HLS. | **Hard.** Once tokens go public-format, rolling back is messy. **Schema/CDN change** — flag and stop. |
| T3.2 | **Edge strategy** — Cloudflare Cache Rules + Page Rules unused; entire Fonto UI is dynamic SSR from one origin. PPR pilot (T2.8) is the bite-sized first step; full edge strategy is the next layer. | New ADR: edge cache for workspace-shape "shells" + CF KV for signed-URL batches at the edge. | **Reversible by removing rules.** But requires CF Workers / API tokens → flag as CDN change. |
| T3.3 | **Single-primary Postgres for read scale** | Read-replica via streaming repl; route grid/search reads to replica with bounded staleness. | Reversible. **Large infra change** — gate to traffic data. |
| T3.4 | **Drop `force-dynamic` blanket** in favour of a typed cache-policy convention (every route declares its cache lifetime + invalidation tag). | New ADR or extension to existing ADR-0001. | Reversible; codebase-wide refactor. |

---

## Expert Panel — Tier 3 Conflicts (surfaced, not resolved)

### T3.1 — Asset delivery architecture (worker-fronted R2 vs Next-proxied)

- **Perf voice:** "Strongest single lever. Each grid tile saves the Next + presigner round-trip; LCP on mobile cellular drops measurably. Workers are pennies."
- **UX voice:** "Cuts the auth context. We currently rely on `Authorization` being present so we can do per-asset access checks at the proxy (private/shared/face-cropped fallback logic in `/api/v1/assets/[id]/url:30-107`). A signed-token model needs equivalent fine-grained policy or we leak."
- **Maintainability voice:** "Two delivery paths is two bug surfaces. Signed-token-in-querystring also means rotating signing keys is now a public-cache invalidation problem. The current single-source-of-truth Next route is verbose but auditable."

**Decision needed from operator:** acceptable to add a *second* delivery path (public-thumb fast lane + private-asset proxy fallback), or stick with single proxy and absorb the latency?

### T3.2 — Edge strategy

- **Perf voice:** "PPR + workspace-shape caching at the edge is the future. We're paying SSR cost for shells that change rarely."
- **UX voice:** "Workspace shells include name + colour + last-active — fine to cache. Anything user-personalised (favorites, recent) cannot be edge-cached without per-cookie variance, and that defeats the purpose."
- **Maintainability voice:** "Adding CF Workers means a new ops surface (Worker logs, KV namespaces). NAS-deploy story doesn't cover this."

**Decision needed:** is the perf gain worth a CF Workers surface? If no, scope PPR pilot only (T2.8) and skip T3.2.

### T3.3 — Read replica

- **Perf voice:** "Premature unless we see CPU/queue saturation on pushd."
- **UX voice:** "Bounded staleness on the grid is fine; bounded staleness on 'I just uploaded' is not. Need careful per-route routing."
- **Maintainability voice:** "Replication lag handling is its own headache. Don't open this door until grafana shows it's needed."

**Decision needed:** measure first. Add `pg_stat_statements` + per-route DB latency histograms before considering.

### T3.4 — Cache policy convention

- **Perf voice:** "Right answer. `force-dynamic` blanket is the single biggest reason Next caching does nothing for us."
- **UX voice:** "If tags are wrong, users see stale lists. The blast radius of a missed `revalidateTag` is real."
- **Maintainability voice:** "Codifying the convention in CLAUDE.md + a lint rule is the right shape. Otherwise tag drift over years."

**Decision needed:** sign off on a convention doc as part of this initiative, before any per-route audit happens.

---

## Open Questions for Operator

1. **R2 storage budget for 512/1024 derivatives (T2.3) and AVIF (T2.3).** ~2.2× current derivative storage. Greenlight?
2. **Worker-fronted R2 (T3.1) — appetite for a second delivery path?** Reversibility class: hard. This is the one-way door.
3. **CF Workers operational surface (T3.2) — acceptable or veto?**
4. **Acceptable staleness on `tags` / `collections` / `persons` caches** (T2.2) — 30 s, 5 min, "until mutation event"?
5. **Composite-index migration (T1.5)** — proceed without ADR (small, reversible) or write a one-paragraph ADR-0009?
6. **`force-dynamic` audit (T1.3)** — operator green-light on the convention doc before per-route audit?
7. **Measurement infra** — operator OK if we add `pg_stat_statements` + per-route DB-call histograms before any Tier 3 work? Tier 1 wins don't require it.

---

## Out of Scope (per constraints)

- Plexo / Pex AI work (vision, OCR, embeddings, face detect, evidence). All "intelligence" stays where it is.
- New dependencies, CDN/edge changes, schema migrations: **flagged and stopped** above, listed but not implemented.
- Mobile (Flutter shell): observed to hit the same `/api/v1/assets/urls` batch endpoint as web; T2.3 (responsive srcset) carries over via the same batch URL contract. No mobile-specific work proposed.

---

## Awaiting go from operator before any code, schema, or config edits.
