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
- [x] CLIP-class distribution audit (subagent) — n=40, 8 distinct classes, only 1 (the "photo" bucket, n=21) clears ≥10. Verdict: ship Things as placeholder, defer live grid to Phase 4.1.
- [x] `app/(app)/app/explore/page.tsx` w/ three tiles
- [x] People tile — links to existing `/app/people`; surfaces count from `/api/v1/persons`
- [x] Places tile — links to existing `/app/map`; surfaces count from `/api/v1/assets?hasGeo=1&limit=1`
- [x] Things tile — links to new `/app/explore/things`; shows "Coming soon" badge instead of count
- [x] Things route — placeholder explainer page (recon verdict ⇒ no live grid in v1)
- [x] Sidebar — Explore entry added between Updates and Inbox
- [x] Commit + push (5f0a72b)
- [x] DEPLOYED to NAS 2026-05-27 — `/app/explore` + `/app/explore/things` live; sidebar entry visible; existing People + Map routes unchanged

### Phase 4.1 follow-up (deferred — not blocking 4 exit)
- [x] Investigate why `classify_method` is 100% `llm-fallback` in prod. **ROOT CAUSE: type-erased dynamic import in `lib/classify/vectors.ts:27–47` stubbed `embedText` as `Promise<number[]>` but real return is `Promise<{vector, modelId}>` — taxonomy cache stored objects, `cosine()` scored 0 every time, threshold never met.** Fix landed as commit 6e85410 + deployed to worker 2026-05-27.
- [ ] Verify the fix in prod — wait for the next image upload after deploy; check `SELECT classify_method, count(*) FROM fonto.assets GROUP BY 1` shows `clip` > 0.
- [ ] Backfill `clip_vec` on the 40% of classified rows that lack one — partial index will otherwise stay sparse and similarity-browse will be inconsistent. (`pnpm backfill:clip` per package.json:18)
- [ ] Once corpus has ≥6 classes with ≥10 members each (today: 1), graduate Things from placeholder → live class-tile grid.

## Phase 5 — Redirect layer + changelog dialog ⚠
- [x] OPERATOR GATE — operator confirmed "Ship now via middleware.ts" (2026-05-27)
- [x] Extend `middleware.ts` with old→new route map — exact-pathname match for every consolidated landing route (Library 6, Collections 3, Updates 3). Detail routes (`/projects/<id>` etc) NOT mapped.
- [x] Pre-applied query strings on each redirect (incoming params win on collision)
- [x] `ui_v2_seen_at` — localStorage flag (`fonto:ui_v2_seen_at`) chosen over DB column so Phase 5 ships without a migration. DB graduation tracked as follow-up if cross-browser persistence becomes valuable.
- [x] "What moved where" dialog component (`_components/ui-v2-changelog-dialog.tsx`)
- [x] Dialog gated on localStorage flag null/missing, dismissible per-browser
- [x] Sidebar + app-shell brand links repointed `/app/dashboard` → `/app/home` so they don't bounce through the new redirect
- [x] Commit + push (012bb2a)
- [x] Manual E2E — every old route returns 307 w/ correct destination + qs (10/10 routes verified, including param preservation `/photos?favorite=1` → `/library?favorite=1&mime=image%2F`)
- [x] Detail-route passthrough verified — `/app/projects/abc` skips the Phase 5 map, falls through to /login auth-redirect (exact-match only)
- [x] DEPLOYED to NAS 2026-05-27 — `/app/photos`, `/app/timeline`, `/app/documents`, `/app/trash`, `/app/projects`, `/app/smart-collections`, `/app/stacks`, `/app/dashboard`, `/app/activity`, `/app/shared` all 307→consolidated routes; changelog dialog mounted in app-shell

## Phase 6 — Mobile bottom-bar nav
- [x] `components/app-mobile-bottom-bar.tsx` w/ 5 tabs (Library, Explore, Collections, Updates, Search)
- [x] Visibility — `<md` breakpoint only via `md:hidden`
- [x] A11y contract (UX-C3) — `role="navigation"`, real `<a>` (not buttons), `aria-current="page"` on active, visible labels
- [x] Sidebar drawer collapsed to hamburger on mobile (existing pattern preserved)
- [x] Settings demoted to avatar menu on mobile (UX-C6) — new `components/app-mobile-avatar-menu.tsx`; carries Home + Settings + Sign out w/ Escape-to-close + backdrop dismiss
- [x] Touch-target audit — each tab is `min-h-[56px]` + `flex-1` width; exceeds the 44×44 iOS HIG floor
- [x] Mobile header consolidated to single strip (brand · plexo status · avatar) — was two strips before
- [x] Commit + push (d2f4207)
- [x] DEPLOYED to NAS 2026-05-27 — bundled with Phase 7a in combined web build; smoke `/` 200, all app routes 307 (unauth as expected)

## Phase 7a — Sidebar cleanup + reorder
- [x] Remove deprecated entries from `components/app-sidebar.tsx` — 13 removed (Photos, Timeline, Memories, Folders, Documents, Trash, Inbox, Activity, Shared with me, Projects, Smart Collections, Stacks, People, Map)
- [x] Reorder surviving entries to match bottom-bar: Home → Library → Explore → Collections → Updates → Search → Settings
- [x] aria-current="page" added to active item (consistency w/ Diego's UX-C3 contract)
- [x] Sub-route prefix-match for active state (e.g. /app/collections/<id> keeps Collections highlighted)
- [x] Commit + push (924b28d)
- [x] DEPLOYED to NAS 2026-05-27 — bundled with Phase 6 in combined web build; sidebar now 7 entries live at myfonto.com

### Phase 7b — Pin most-recent 3 albums under Collections (Immich pattern)
- [ ] DEFERRED — needs a runtime fetch (recent albums) + a sub-list primitive under the Collections nav entry. Static-cleanup phase 7a landed first; 7b ships separately when the operator wants the Immich-style pinned-albums affordance.

## Phase 7 — Sidebar cleanup + polish
- [ ] Remove deprecated entries from `components/app-sidebar.tsx` (Timeline, Memories, Folders, Photos, Documents, People, Map, Inbox, Activity, Shared with me, Projects, Smart Collections, Stacks, Trash)
- [ ] Reorder surviving entries: Home, Library, Explore, Collections, Updates, Search, Settings
- [ ] Pin most-recent 3 albums under the Collections entry (Immich pattern)
- [ ] Commit + push
