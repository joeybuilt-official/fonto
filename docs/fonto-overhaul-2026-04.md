# Fonto Overhaul — 2026-04 Panel Audit

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

## Panel summary

**DAM domain (Eagle / Pixxel / Apple Photos / Immich lens).** Capture is solid — drag/drop, paste, multi-file, source provenance. Browse is now Immich-inspired with a lightbox, multi-select, metadata panel, collections, projects, smart collections — origin/main is well past the original audit baseline. The remaining table-stakes hole, vs Eagle/Apple Photos/Pixxel: **public share links.** Every consumer-grade DAM has time-bounded share. Fonto did not.

**UX/IA.** Sidebar groups by data-type today (Photos / Documents / Projects / Collections / Smart Collections). Defensible — Fonto's user is power-organizing, not just consuming. Adding share inline to the existing lightbox metadata panel preserves the established interaction model rather than introducing a new asset-detail surface that would compete with the lightbox.

**Visual / token compliance.** Token-clean. Share button uses `border-border / bg-background / text-muted-foreground / text-destructive` only. No new palette.

**Performance.** Share page server-renders with a single signed-URL call; HEAD probe falls back to the legacy R2 key path. No client round-trips beyond the asset blob itself.

**AI.** Untouched in this pass — origin already covers classify + describe + reprocess + similarity.

**Conflict resolved.** Domain panel wanted a dedicated `/app/a/[id]` detail page; UX panel argued it would compete with the existing lightbox metadata panel and split the interaction surface. **Decision: extend the lightbox.** Reason: origin already shipped a 70-30 lightbox/grid pattern that users will be muscle-memorying; introducing a parallel route splits attention without adding info. Share belongs *next to* download and trash, not on a separate page.

## Ranked priorities (this session)

1. **Share links** — token table + create/list/revoke API + public `/share/[token]` route + lightbox button. **SHIPPED.**
2. **Perceptual dedup (pHash)** — 64-bit DCT-based hash, Hamming-distance-≤5 near-duplicate prompt at upload. **SHIPPED.**
3. **Color search** — 8-color k-means palette per asset, ΔE-76 LAB-space match (threshold 30), 12-color quick-pick + custom hex picker. **SHIPPED.**
4. **OCR-only search** — `vision.ocr` PAX endpoint (Plexo) + `ocr_text` / `ocr_state` columns + nightly cron at `/api/v1/cron/ocr-backfill` + toggle in the search bar. **SHIPPED.**

Items the origin/main parallel work already covered (so I did not re-ship): asset detail surface (lightbox metadata panel), bulk select, density/grid (Immich grid), search chips (FTS search route), confirm-button (canonical), responsive mobile layout, two-step destructive confirms, projects + smart-collections + collection-detail pages, dual-panel doc viewer.

Deferred to a future pass (with reason):
- **Browser-extension capture shortcut** — needs a separate web extension repo.
- **Share password / domain allow-list** — over-engineered for v1, holds for user feedback.
- **Video pHash via first frame** — sharp cannot decode video; deferred until an ffmpeg dep lands. The pipeline silently skips pHash for non-image MIME types so the column stays `NULL` on videos.

## Shipped status

| # | Item | Commit | Files | Status |
|---|------|--------|-------|--------|
| 1 | Share links | `6d29323` | 6 files, +402 lines | merged → main, pushed, deployed |
| 2–4 | Perceptual dedup + color search + OCR-only | (this branch) | ~11 files | merged → main, pushed, deployed |

## One-way doors

- **Token format = base64url(24 random bytes)**. 144 bits of entropy, URL-safe. Unique constraint on `token`. Reversing this requires DB migration; chose this over signed JWTs to keep tokens revocable without coordinating signature secrets.
- **`/share/[token]` is unauthenticated.** Token possession = access. Default TTL is 24h, hard cap 30d. Both bounded by code.
- **pHash format = bigint mode 'bigint'.** Stored as a signed Postgres `bigint` (64-bit two's complement). Migrating to a 128-bit hash would require a new column — the existing one's values are not invalidated by the new column.
- **Color palette = JSONB array of `{ hex, weight }`, max 8 entries.** ΔE filtering is done in JS after a SQL pull; this scales to mid-five-figure asset counts without trouble. Larger workspaces will want a Lab-vector index (cube extension) — out of scope for v1.
- **OCR pipeline = single-shot vision call per image.** No chunking, no provider-side OCR (Tesseract/etc.). `ocr_state` is the durable resume marker; flipping a row from `failed` back to `pending` re-queues it.
