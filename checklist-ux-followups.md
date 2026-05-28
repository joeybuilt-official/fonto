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
- [ ] OPERATOR GATE — confirm FU-C3 default (Tess — popover, not flat strip)
- [ ] Wire date chip → date-range popover
- [ ] Wire folder chip → folder-tree popover
- [ ] Wire classification chip → popover w/ active class list
- [ ] Back-button E2E — applies each chip, opens lightbox, asserts grid+state preserved
- [ ] Commit + push
- [ ] DEPLOYED to NAS — rsync + build fonto + force-recreate + smoke
