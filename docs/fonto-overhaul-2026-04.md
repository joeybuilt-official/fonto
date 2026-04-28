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

Items the origin/main parallel work already covered (so I did not re-ship): asset detail surface (lightbox metadata panel), bulk select, density/grid (Immich grid), search chips (FTS search route), confirm-button (canonical), responsive mobile layout, two-step destructive confirms, projects + smart-collections + collection-detail pages, dual-panel doc viewer.

Deferred to a future pass (with reason):
- **Perceptual dedup / pHash** — needs Plexo Pex side wiring; cross-cutting.
- **Color search / OCR-text-only mode** — depends on Pex caption + OCR flags I didn't want to assume.
- **Browser-extension capture shortcut** — needs a separate web extension repo.
- **Share password / domain allow-list** — over-engineered for v1, holds for user feedback.

## Shipped status

| # | Item | Commit | Files | Status |
|---|------|--------|-------|--------|
| 1 | Share links | `6d29323` | 6 files, +402 lines | merged → main, pushed, deployed |

## One-way doors

- **Token format = base64url(24 random bytes)**. 144 bits of entropy, URL-safe. Unique constraint on `token`. Reversing this requires DB migration; chose this over signed JWTs to keep tokens revocable without coordinating signature secrets.
- **`/share/[token]` is unauthenticated.** Token possession = access. Default TTL is 24h, hard cap 30d. Both bounded by code.
