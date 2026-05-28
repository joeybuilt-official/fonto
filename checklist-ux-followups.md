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
- [ ] DEPLOYED to NAS — build (`bmt21wcln`) in flight at handoff; smoke + force-recreate is the first next-session action

## Phase 4.1 — CLIP fix verification + corpus gates
- [ ] OPERATOR GATE — confirm FU-C2 default (Yuki — verify-then-backfill)
- [ ] Write `scripts/verify-clip-classification.ts`
- [ ] Document expected output in script header
- [ ] Run `pnpm verify:clip` against a fresh test image; assert `classify_method='clip'`
- [ ] Run `pnpm backfill:clip` against the current corpus
- [ ] Confirm `clip_vec` coverage hits 100% of image rows
- [ ] Document the Things-graduation gate SELECT in `plan-ux-followups.md` Phase 4.1 block
- [ ] Commit + push

## Phase 1.1 — Library chip-strip polish + back-button E2E
- [ ] OPERATOR GATE — confirm FU-C3 default (Tess — popover, not flat strip)
- [ ] Wire date chip → date-range popover
- [ ] Wire folder chip → folder-tree popover
- [ ] Wire classification chip → popover w/ active class list
- [ ] Back-button E2E — applies each chip, opens lightbox, asserts grid+state preserved
- [ ] Commit + push
- [ ] DEPLOYED to NAS — rsync + build fonto + force-recreate + smoke
