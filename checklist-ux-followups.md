# Fonto UX consolidation follow-ups — checklist

Derived from `plan-ux-followups.md`. Tick boxes as items complete.

## Phase 7b — Pinned albums under Collections sidebar
- [ ] OPERATOR GATE — confirm FU-C1 default (Aisha — sub-list, Immich pattern)
- [ ] Audit subagent — confirm no existing sidebar SSR-prop plumbing
- [ ] Add `recentAlbums` server fetch in `(app)/layout.tsx`
- [ ] Thread `recentAlbums` prop through `AppShell` → `AppSidebar`
- [ ] Render pinned sub-list under the Collections entry in `app-sidebar.tsx`
- [ ] Sub-list active-state: clicking a pin highlights both Collections + the specific pin
- [ ] No layout shift on first paint (SSR-fed, not client-fetched)
- [ ] Commit + push
- [ ] DEPLOYED to NAS — rsync + build fonto + force-recreate + smoke

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
