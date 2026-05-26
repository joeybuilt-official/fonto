# Fonto UX/nav consolidation — master plan

Sibling to `plan.md` (the parity workstream, now substantially shipped).
This file scopes the UX consolidation phases approved by the operator
on 2026-05-25.

## Goal

Collapse the 18-entry sidebar to 6 top-level entries + Settings,
matching OSS norms (Apple 4, Google 3-mobile/~6-web, Immich ~6) and
the Step 1 audit's finding that 5 routes share AssetGrid + 5 routes
share "card grid of groupings."

## Cross-phase decisions captured in ADR

- `adr/0004-ux-nav-consolidation.md` — target nav, alternatives,
  consequences. The target taxonomy is:

```
Home · Library · Explore · Collections · Updates · Search · Settings
```

## Expert panel — surfaced conflicts that need operator calls

Six personas reviewed the audit + benchmark. Conflicts they could not
resolve unilaterally and that need an operator sign-off BEFORE the
named phase executes:

- **UX-C1 — "Home" survives or folds into Updates?**
  - Hiroshi (end-user research): keep Home. The dashboard-landing
    pattern is muscle memory; removing it forces users to reorient.
  - Aisha (IA): fold it. Home and Updates both surface "what's
    happening" — two entries for one job-to-be-done.
  - Default if operator silent: **keep Home for Phase 3**, revisit
    after usage data shows it's underused.

- **UX-C2 — "Trash" as a sub-filter in Library, or kept as own route?**
  - Tess (design lead): own route. Trash needs visual differentiation
    (red accent, "permanently delete" emphasis) that a filter chip
    won't carry.
  - Yuki (DX): sub-filter. Trash is `assets where lifecycleState =
    'trashed'` — same code path with a chip is the maintainable
    answer.
  - Default if operator silent: **sub-filter** (Yuki wins for v1),
    with Tess's visual differentiation handled via a banner inside
    the Library surface when the trash chip is active.

- **UX-C3 — Bottom nav on mobile?**
  - Marcus (mobile UX): yes, ship a 5-tab bottom bar
    (Library / Explore / Collections / Updates / Search). The
    sidebar drawer stays for tablet+.
  - Diego (accessibility): yes, with the caveat that the bottom bar
    needs `role="navigation"` + each tab as `<a aria-current="page">`,
    not the icon-only-button anti-pattern that breaks screen readers.
  - No conflict between Marcus + Diego — they agree on shipping it
    with Diego's a11y contract.
  - Default if operator silent: **ship bottom bar in Phase 6** with
    Diego's a11y contract as exit criteria.

- **UX-C4 — "Stacks" inside Collections, or keep separate?**
  - Aisha (IA): inside Collections. A stack is a user-curated group;
    it belongs with Albums + Projects.
  - Hiroshi: inside Discovery. A stack is most often auto-suggested
    (RAW+JPEG pairs, bursts); the user accepts/rejects rather than
    curates from scratch.
  - Default if operator silent: **inside Collections** (Aisha wins
    for v1) — final-state ownership is user-curated even if the
    proposal flow is automated. Stack-suggestions tab inside the
    Stacks sub-view handles the auto-derived UX.

- **UX-C5 — Activity in Updates, or keep as its own tab?**
  - Aisha: merge into Updates. Activity events + upload status +
    shared-with-me all answer "what changed in my workspace?"
  - Hiroshi: keep Activity separate. Power users distinguish
    "events" (comments, members) from "new content" (uploads,
    shares). Conflating risks burying both.
  - Default if operator silent: **merge** (Aisha wins for v1).
    Updates uses internal sections (Uploads / Activity / Shared)
    to preserve the separation Hiroshi cares about without a
    separate route.

- **UX-C6 — Settings drawer behind avatar on mobile, or always-shown?**
  - Tess: always-shown. Brand consistency across viewports.
  - Marcus: behind avatar. The 5-tab bottom bar is non-negotiable;
    Settings is the obvious demotion candidate.
  - Diego: as long as the avatar menu is keyboard-reachable + the
    Settings link inside it has a screen-reader-visible label, the
    demotion is fine.
  - Default if operator silent: **behind avatar on mobile** (Marcus
    + Diego majority).

Each gate is a sign-off before the phase that consumes it.

## Pre-mortem (Step 4)

Three plausible failure modes for this workstream:

1. **Bookmark breakage erodes trust.** Power users have direct URLs
   to `/app/photos?favorite=1` etc; if those 404 after consolidation,
   the consolidation looks like regression even when the destination
   is objectively better.
   - **Fallback:** Phase 5 ships a redirect layer (Next.js `middleware.ts`
     pre-existing — extend it) that maps every old route to the
     consolidated route + the right pre-applied filter. Keep redirects
     in place for ≥3 release cycles before considering removal.

2. **Filter chips fail discoverability.** A nav item with an icon and
   label is more discoverable than a chip nested inside a toolbar.
   Folding 5 routes into Library may make features feel "missing"
   even when they're a click away.
   - **Fallback:** ship a one-time "What's new" dialog after first
     login post-deploy that walks through the 4 chip groups (date /
     mime / classification / folder), with a "got it" dismissal that
     persists per-user. If telemetry (or feedback) shows chip usage
     drops vs the equivalent old-route traffic, add a "Recently
     viewed filters" pinned chip strip.

3. **Refactor breaks state-preservation across navigation.** Today,
   pressing browser-back from a lightbox returns to the exact grid
   position. Folding routes into one Library page risks losing that
   if the consolidated page doesn't shard URL state per filter.
   - **Fallback:** every Phase 1 commit ships with a manual E2E test
     of the back-button preservation across each filter chip combo.
     If the URL state shape is going to change, ship a one-time
     migration in `middleware.ts` that reshapes old query strings
     to the new layout.

---

## Phase 1 — Library consolidation (5 routes → 1)

- Scope: build `app/(app)/app/library/page.tsx` that hosts a single
  AssetGrid wrapped with a chip-strip toolbar. Chips: lifecycle
  (active / archived / trashed), mime (image / video / document /
  other), classification (when mime=document), date (all / on-this-day
  / this-month / custom range), folder-path (folder tree popover).
  Sort modes: newest / oldest / largest. Reuses the existing
  `useToolbarState` hook + extends it with the new chips.
- Deps: ADR 0004 finalised. UX-C2 confirmed (trash as chip).
- Subagents: Explore for the current toolbar-state API surface +
  AssetGrid prop shape (~250 words).
- Exit: `/app/library` ships. AssetGrid behaviour identical to
  `/app/photos` when no chips are active. Each chip combination maps
  to a stable URL query string.
- Status: pending

## Phase 2 — Collections fan-out (5 routes → 1 + sub-tabs)

- Scope: build `app/(app)/app/collections/page.tsx` (rename the
  current `collections` to `albums` sub-tab inside) with four tabs:
  My albums, Smart, Projects, Stacks. Each tab is the existing
  page's logic moved into a tab-panel component, no behavior change
  yet — just route relocation + a tab-bar wrapper.
- Deps: Phase 1 shipped (so the operator can validate the chip
  pattern before we apply a similar fan-out pattern). UX-C4
  confirmed (Stacks under Collections).
- Subagents: Explore for cross-imports of the four pages — any
  other component reaches into them directly?
- Exit: `/app/collections` shows the four tabs. Direct routes
  (`/app/projects`, `/app/stacks`, `/app/smart-collections`) still
  load but show a deprecation banner.
- Status: pending

## Phase 3 — Updates merge (Inbox + Activity + Shared)

- Scope: build `app/(app)/app/updates/page.tsx` with three sections
  (Uploads / Activity / Shared with me) stacked vertically. Each
  section reuses the existing page's data hooks. Mobile collapses
  sections into a single tab-bar at the top of the page.
- Deps: Phase 2 shipped. UX-C1 (Home stays) + UX-C5 (Activity
  merges into Updates) confirmed.
- Subagents: none.
- Exit: `/app/updates` ships. Old `/app/dashboard`, `/app/activity`,
  `/app/shared` redirect (Phase 5) here w/ the right section
  anchor.
- Status: pending

## Phase 4 — Explore hub (People + Map + future Things)

- Scope: build `app/(app)/app/explore/page.tsx` as a tile-landing
  page. Tiles: People (existing), Places (existing Map view), Things
  (new — CLIP-clustered top classifications as cards). Each tile
  click navigates to the existing route OR the new Things route
  (`/app/explore/things`).
- Deps: Phase 3 shipped.
- Subagents: Explore for the CLIP-classification distribution — what
  classes have ≥N members? That answers whether Things-as-tiles is
  worth shipping in v1 or deferring.
- Exit: `/app/explore` shows the three tiles. Things route exists
  even if sparse.
- Status: pending

## Phase 5 — Redirect layer + changelog dialog ⚠ (user-facing migration)

- Scope: extend `middleware.ts` to map every old route to its
  consolidated destination with the right pre-applied query string.
  Add a one-time "What moved where" dialog gated on a
  `ui_v2_seen_at` user preference, dismissible per-user.
- Deps: Phases 1–4 shipped.
- Subagents: none.
- Exit: every old route either renders w/ a "moved →" banner or
  redirects cleanly. Dialog shows on first load post-deploy and
  never again per-user after dismiss.
- Status: pending

## Phase 6 — Mobile bottom-bar nav

- Scope: build `components/app-mobile-bottom-bar.tsx` rendered at
  viewport `<md` only. Five tabs: Library, Explore, Collections,
  Updates, Search. Sidebar drawer collapsed to a hamburger that
  surfaces Home + Settings + sign-out. UX-C6 demotion of Settings
  to the avatar menu on mobile.
- Deps: Phase 5 shipped.
- Subagents: none.
- Exit: viewport `<md` shows the bottom bar. Diego's a11y contract
  (UX-C3) verified: each tab is `<a>`, `aria-current="page"` is set
  on the active one, the bar has `role="navigation"`.
- Status: pending

## Phase 7 — Sidebar cleanup + final polish

- Scope: remove the deprecated nav entries from
  `components/app-sidebar.tsx`. Reorder the surviving entries to
  match the bottom-bar order (Library → Explore → Collections →
  Updates → Search). Pin most-recent 3 albums under the Collections
  entry (Immich pattern).
- Deps: Phase 6 shipped + the deprecation banners (Phase 2/3 exits)
  have been live for ≥1 release cycle so users have had time to
  retrain.
- Subagents: none.
- Exit: sidebar shows 7 entries (Home, Library, Explore,
  Collections, Updates, Search, Settings). No deprecated routes
  visible. Pinned albums render under Collections.
- Status: pending
