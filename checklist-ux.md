# Fonto UX consolidation checklist

Derived from `plan-ux.md`. Tick boxes as items complete.

## Phase 1 — Library consolidation
- [x] OPERATOR GATE — UX-C2 = **sub-filter chip** (operator approved plan-defaults 2026-05-25; trash is a `lifecycle=trashed` chip, banner handles visual differentiation)
- [x] Extend `useToolbarState` with chip-state for lifecycle/mime/classification/date/folder (added `lifecycle`, `directoryPath`, `directoryPathPrefix`; mime + classification + from/to already existed)
- [x] Build `app/(app)/app/library/page.tsx` wrapping AssetGrid
- [x] Chip strip — lifecycle (active/archived/trashed)
- [x] Chip strip — mime (All / Images / Videos / Documents)
- [ ] Chip strip — classification (visible when mime=document) — DEFERRED; reuse existing FilterPopover for now
- [ ] Chip strip — date (full picker) — DEFERRED; chip only shows clear-action when `from`/`to` set via URL; full calendar popover lands in Phase 1.1
- [ ] Chip strip — folder path (popover tree picker) — DEFERRED; chip only shows clear-action when `path`/`pathPrefix` set via URL; tree popover lands in Phase 1.1
- [x] Sort modes — newest/oldest/largest/name/rating (largest added)
- [x] URL query-string stability — chip changes round-trip through `useToolbarState`'s router.replace path (proven by existing FilterState pattern)
- [ ] Back-button state preservation across chip changes (manual E2E test — DEFERRED to operator validation)
- [x] Trash banner — red-accent destructive-tone banner above grid when lifecycle=trashed
- [x] Commit + push (114801b)
- [x] DEPLOYED to NAS 2026-05-25 — `/app/library` live, 307 to login when unauth, sidebar shows entry between Home and Inbox

## Phase 2 — Collections fan-out
- [x] OPERATOR GATE — UX-C4 = **inside Collections** (operator approved plan-defaults 2026-05-25; Stacks tab + Suggestions sub-section land under /app/collections)
- [x] Tab-bar primitive at `app/(app)/app/collections/_components/tab-bar.tsx` (anchor-tabs, ARIA tablist/tab/aria-selected/aria-current per Diego's UX-C3 contract)
- [x] My albums tab — relocate current Collections logic → `_components/albums-tab.tsx`
- [x] Smart tab — relocate current Smart Collections logic → `_components/smart-tab.tsx`
- [x] Projects tab — relocate current Projects logic → `_components/projects-tab.tsx`
- [x] Stacks tab — relocate current Stacks logic; inner "stacks / suggestions" split preserved → `_components/stacks-tab.tsx`
- [x] Tab wrapper at `app/(app)/app/collections/page.tsx` — `?tab=albums|smart|projects|stacks` URL state, default = albums
- [x] Direct routes (`/app/projects`, `/app/stacks`, `/app/smart-collections`) render w/ deprecation banner pointing at consolidated location (Phase 5 will replace these stubs with hard redirects in middleware)
- [x] Commit + push (19c6fc4)
- [x] DEPLOYED to NAS 2026-05-27 — `/app/collections` + `/app/collections?tab=smart|projects|stacks` live; deprecated `/app/smart-collections`, `/app/projects`, `/app/stacks` all 307 (unauth → login) and render banners when authed

## Phase 3 — Updates merge
- [x] OPERATOR GATE — UX-C1 + UX-C5 = **plan defaults applied** (operator-silent; Home stays + Activity merges into Updates per plan-ux.md). Revisit once usage data exists.
- [x] `app/(app)/app/updates/page.tsx` w/ three vertical sections
- [x] Uploads section — relocated Inbox's upload queue + recent grid (`_components/uploads-section.tsx`); MemoryCard moved to shared `app/(app)/app/_components/memory-card.tsx`
- [x] Activity section — relocated Activity feed (`_components/activity-section.tsx`); deep-link target switched from `/app/photos?asset=` to `/app/library?asset=` to align with Phase 1
- [x] Shared with me section — relocated Shared list (`_components/shared-section.tsx`)
- [x] Mobile collapse — top tab bar switches between the three sections (`md:hidden` on the strip; sections stack on `md+`)
- [x] Deep-link anchors (`?section=uploads|activity|shared`) — wrapper scrolls the matching `#updates-section-*` anchor into view
- [x] Sidebar — Updates entry added between Library and Inbox
- [x] Deprecation banners on `/app/dashboard`, `/app/activity`, `/app/shared` — each re-renders the section body with banner; Phase 5 will replace with middleware redirects
- [x] Shared primitives — tab-bar + deprecation-banner promoted to `app/(app)/app/_components/` so Phase 2 + 3 compose from one source (tab-bar gains `paramName` + `className` props)
- [x] Commit + push (2548ad0)
- [x] DEPLOYED to NAS 2026-05-27 — `/app/updates` + `?section=uploads|activity|shared` live; deprecated `/dashboard`, `/activity`, `/shared` all 307 (unauth) and render banners when authed

## Phase 4 — Explore hub
- [ ] `app/(app)/app/explore/page.tsx` w/ three tiles
- [ ] People tile — links to existing `/app/people`
- [ ] Places tile — links to existing `/app/map`
- [ ] Things tile — links to new `/app/explore/things`
- [ ] Things route — top-N CLIP-classification cards w/ counts
- [ ] CLIP-class distribution audit (subagent) — confirm there are ≥6 classes with ≥10 members worth surfacing
- [ ] Commit + push

## Phase 5 — Redirect layer + changelog dialog ⚠
- [ ] Extend `middleware.ts` with old→new route map (every old route)
- [ ] Pre-applied query strings on each redirect (so `/app/photos?favorite=1` → `/app/library?favorite=1&mime=image`)
- [ ] `ui_v2_seen_at` preference column on the user-settings table (or local-storage equivalent)
- [ ] "What moved where" dialog component
- [ ] Dialog gated on `ui_v2_seen_at IS NULL`, dismissible per-user
- [ ] Manual E2E — every old route renders correct destination
- [ ] Commit + push

## Phase 6 — Mobile bottom-bar nav
- [ ] `components/app-mobile-bottom-bar.tsx` w/ 5 tabs
- [ ] Visibility — `<md` breakpoint only
- [ ] A11y contract (UX-C3) — `role="navigation"`, `<a aria-current="page">` for active tab, visible labels
- [ ] Sidebar drawer collapsed to hamburger on mobile
- [ ] Settings demoted to avatar menu on mobile (UX-C6)
- [ ] Touch-target audit — each tab ≥44×44 px (iOS HIG minimum)
- [ ] Commit + push

## Phase 7 — Sidebar cleanup + polish
- [ ] Remove deprecated entries from `components/app-sidebar.tsx` (Timeline, Memories, Folders, Photos, Documents, People, Map, Inbox, Activity, Shared with me, Projects, Smart Collections, Stacks, Trash)
- [ ] Reorder surviving entries: Home, Library, Explore, Collections, Updates, Search, Settings
- [ ] Pin most-recent 3 albums under the Collections entry (Immich pattern)
- [ ] Commit + push
