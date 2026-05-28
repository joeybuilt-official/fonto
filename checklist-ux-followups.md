# Fonto UX consolidation follow-ups — checklist

Derived from `plan-ux-followups.md`. Tick boxes as items complete.

## Phase 7b — Pinned albums under Collections sidebar
- [x] OPERATOR GATE — operator approved 2026-05-27 ("Approved — execute Phase 7b")
- [x] Audit subagent — confirmed `(app)/layout.tsx` only passes `user`; need to thread new prop through `AppShell` → `AppSidebar`. Server-fetch pattern = direct Drizzle query (no helper)
- [x] `lib/sidebar/recent-albums.ts` — server-only helper, top-3 by createdAt desc, scoped to workspace
- [x] `recentAlbums` SSR-fetched in `(app)/layout.tsx`
- [x] Threaded through `AppShell` → `AppSidebar`
- [x] Sub-list renders under Collections entry; pin row active when `pathname === /app/collections/<id>`
- [x] No layout shift — data flows server → client as prop, no client-fetch
- [x] Commit + push (ae3a5d5)
- [x] DEPLOYED to NAS — build (`bmt21wcln`) deployed 2026-05-28; `/` 200, `/app/library` 307 ✓

## Phase 4.1 — CLIP fix verification + corpus gates
- [x] OPERATOR GATE — confirmed 2026-05-28 ("Go. Proceed.")
- [x] Write `scripts/verify-clip-classification.ts`
- [x] Document expected output in script header
- [x] Run `pnpm verify:clip` against a fresh test image; assert `classify_method='clip'` — PASS (topLevel=photo, confidence=0.2114)
- [x] Run `pnpm backfill:clip` against the current corpus — 0 enqueued (all active images already had clip_vec)
- [x] Confirm `clip_vec` coverage hits 100% of image rows — 24/24 active; 3 archived skipped (correct)
- [x] Document the Things-graduation gate SELECT in `plan-ux-followups.md` Phase 4.1 block
- [x] Commit + push

## Phase 1.1 — Library chip-strip polish + back-button E2E
- [x] OPERATOR GATE — FU-C3 approved 2026-05-28 (Tess — popover, not flat strip)
- [x] Wire date chip → date-range popover (always-visible, opens from/to picker)
- [x] Wire folder chip → folder-tree popover (fetches /api/v1/folders/tree)
- [x] Wire classification chip → popover w/ active class list (CLASSIFICATION_CHIPS)
- [x] URL-based lightbox (?lb=<id>) so browser back closes lightbox + restores chip state
- [x] Playwright E2E — auth setup + library-chips spec; 6 pass, 2 skip (corpus-conditional)
- [x] Commit + push (9f93543, 49decdd)
- [x] DEPLOYED to NAS — rsync + build fonto + force-recreate 2026-05-28; / 200, /app/library 307 ✓

## Phase 5.2 — Lightbox deep-link + scroll-restore
- [x] GET /api/v1/assets/:id — new single-asset endpoint (auth-gated, workspace-scoped)
- [x] Direct external URL: cold-load ?lb=<id> opens lightbox; fallback fetches asset directly when not in filtered list
- [x] Scroll-restore: openLightbox saves window.scrollY; useEffect restores on lightbox close; router.push w/ scroll:false prevents page jump on open
- [x] OG meta tags: generateMetadata on /share/[token] — og:title, og:description, og:image (presigned thumb), twitter:card
- [x] Share-link → lightbox: authenticated users hitting /share/<token> (asset target) redirect to /app/library?lb=<assetId>
- [x] Commit + push
- [x] DEPLOYED to NAS — rsync + build + force-recreate 2026-05-28; / 200, /app/library 307 ✓
