# Fonto — Asset Page Audit & Redesign Plan

_Multi-agent UX audit, 2026-05-24. Triggered by user feedback on the
documents page wasted space and the lack of consistent search / sort /
filter / AI chat across asset-bearing pages._

## 1. Toolbar Contract

Every asset-bearing page MUST expose the same upper-region affordances,
in this order, left-to-right, in a single sticky toolbar that does not
scroll with content:

| Slot | Control | Behavior |
|---|---|---|
| 1 | **Title + count** | "Photos · 1,243" — one line, no separate subtitle |
| 2 | **Search input** | Scoped to the current view (debounced, ⌘K opens global) |
| 3 | **Sort dropdown** | newest / oldest / largest / name / rating |
| 4 | **Filter button** | opens a popover with classification, date range, tag, person, color, favorite, rating, mime |
| 5 | **AI Chat / Ask** | sparkles icon → opens a side-rail chat scoped to *the currently visible result set* |
| 6 | **View mode** | grid / list / map / timeline (whichever apply) |
| 7 | **Density toggle** | comfortable / compact / dense (changes grid column count) |
| 8 | **Select mode** | enters multi-select; reveals batch action bar at bottom |
| 9 | **Page-specific action** | "+ New collection", "Run clustering", "Upload" |

### Shared component sketch

`app/(app)/app/_components/asset-page-toolbar.tsx` (new):

```ts
interface AssetPageToolbarProps {
  title: string;
  count?: number;
  searchValue: string;
  onSearchChange: (v: string) => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  filters: FilterState;          // classification, dateRange, tagIds, personIds, color, favorite, ratingMin, mime
  onFiltersChange: (f: FilterState) => void;
  availableFilters?: Array<keyof FilterState>;  // page chooses which to expose
  viewMode?: ViewMode;
  onViewModeChange?: (v: ViewMode) => void;
  availableViewModes?: ViewMode[];
  density: "comfortable" | "compact" | "dense";
  onDensityChange: (d: Density) => void;
  selectMode: boolean;
  onToggleSelect: () => void;
  onAskAI?: (contextAssetIds: string[]) => void;
  primaryAction?: { label: string; icon: ReactNode; onClick: () => void };
}
```

Persist density + last-used filters per page in `localStorage` under
`fonto:toolbar:<page>`.

## 2. Per-Page Audit

WS = wasted-space score (1 = dense, 5 = sparse).

| Page | WS | Missing controls | Top recommendation |
|---|---|---|---|
| **dashboard** | 3 | search, sort, AI chat, density | Split: dashboard = inbox/stats; move grid to /photos |
| **photos** | 2 | search, AI chat, density, view-mode | Add toolbar; promote search; persist filters in URL |
| **documents** | **5** | search, sort, AI chat, multi-select, density, list/grid toggle, file preview thumb | Replace 1-col list with 2-pane: list left, preview right, persistent |
| **folders** | 3 | search-within-folder, sort, AI chat, multi-select, density | Tree sidebar + breadcrumb + grid; add folder ops (rename/move) |
| **map** | 2 | text search, date range, filter chips, AI chat | Floating filter panel; date scrubber below map |
| **memories** | 4 | search, sort, filter, AI chat, year-jump nav | Add year-rail (right side); collapse old years |
| **people** | 3 | search by name, sort (count/recent), AI chat, merge/split UI | Inline-rename, drag-to-merge, "needs review" tab |
| **projects** | 4 | search, sort, AI chat, project thumbnail, color picker on create | Card cover from latest asset; multi-collection drag-drop |
| **search** | 2 | sort, density, save-as-smart-collection, grid view, AI chat | Add view toggle (list/grid/timeline); "Save search" button |
| **smart-collections** | 4 | search, run-now preview count, sort, AI chat, edit-in-place | Show live result count badge per row; quick-edit query inline |
| **timeline** | 2 | text search, AI chat, density, jump-to-date | Year/month rail (Immich-style scrubber); sticky date headers |
| **trash** | 4 | search, sort, filter, multi-select, "empty trash", retention countdown | Add bulk restore/delete; show "X days until auto-purge" |
| **collections** | 4 | search, sort, AI chat, density, cover override | Stop per-card cover N+1 fetch; batch cover URLs server-side |

## 3. Quick Wins (≤1 day each)

- **documents list**: drop sparse 1-col flex layout; render as 2-col grid + persistent preview pane on ≥md. `app/(app)/app/documents/page.tsx:211`.
- **collections N+1**: `CollectionCover` does 2 sequential fetches per card. Have `/api/v1/collections` include `coverAssetId` + `coverThumbUrl`. `app/(app)/app/collections/page.tsx:21-62`.
- **photo-card `animate-pulse` bug**: `isProcessing = processingState !== "ready"` pulses *every* tile whose state is "captured", "queued", etc. — likely most of the grid on first load. Should only pulse for actively-processing states. `app/(app)/app/_components/photo-card.tsx:149,184`.
- **memories AssetTile N+1**: each tile fetches its own URL — should batch via `/api/v1/assets/urls?ids=...`. `app/(app)/app/memories/page.tsx:53-83`.
- **folders unscoped fetch**: pulls *entire* asset list then filters client-side. Add `?directoryPath=` server param. `app/(app)/app/folders/page.tsx:132-146`.
- **photos page header**: move "Select" into toolbar; reclaim 80px vertical. `app/(app)/app/photos/page.tsx:276-303`.
- **trash retention**: surface "Auto-delete in N days" per row (assumes retention exists; if not, add it). `app/(app)/app/trash/page.tsx:82-87`.
- **search debounce**: every keystroke fires both `/search` and possibly `/search/clip` — add 250ms debounce. `app/(app)/app/search/page.tsx:242`.
- **timeline filter chips overflow**: collapse mime + favorite + rating into the unified Filter popover. `app/(app)/app/timeline/page.tsx:127-173`.
- **map title bar**: `px-4 py-3` is wasted real estate above the map. Make the map full-bleed; overlay title + stats as floating chip. `app/(app)/app/map/page.tsx:323-341`.

## 4. Page-Specific Overhauls (1–3 days each)

- **documents**: rebuild as Notion-style 3-column: folder/type rail | list with thumbs | persistent preview. Auto-OCR-snippet under each row. Adopt shared toolbar.
- **dashboard** (696 LOC): split into **Inbox** (upload + recent + dup prompts + queue) and a real **Home** (stats, memory of day, quick-jump tiles to each section). The grid at the bottom duplicates /photos.
- **folders**: add a left tree (collapsible), per-folder ops (rename/move/delete), and drag-and-drop to move assets between folders.
- **people**: introduce "Needs review" cluster bucket, drag-to-merge, in-place rename, hide-person toggle visible on card.
- **timeline**: implement a Photos-style scrubber rail (year ticks → month) using already-virtualised list; add jump-to-date button.
- **map**: add a synced filter strip (date range scrubber, classification chips) plus an "Ask AI about this area" prompt that posts bbox + viewport to chat.
- **search**: result rendering as grid+thumbs (currently list-only — visual queries returning images deserve thumbnails). Save current query as smart collection in one click.
- **smart-collections**: live preview count + sample 4 thumbs per row; inline-edit the query JSON via a structured editor (don't show raw JSON).

## 5. Cross-Cutting Infrastructure

- **`<AssetPageToolbar>`** — replaces the 13 hand-rolled headers. Saves ~40–80 LOC per page and unifies search/sort/filter URL params.
- **Batch URL endpoint** `POST /api/v1/assets/urls` accepting `{ids, variant}` returning `{[id]: url}` — kill the N+1 in `photo-card.tsx:160`, `memories/page.tsx:58`, `collections/page.tsx:33`, `dashboard/page.tsx:112`. Each grid currently spawns N HTTP requests on render.
- **`<AssetGrid>`** primitive accepting `density` + `viewMode` — wraps PhotoCard, handles selection, range-select (currently re-implemented in `photos/page.tsx:190-213`), and virtualises ≥500 items.
- **`<FilterPopover>`** — single component driving classification, date range, tag, person, color, favorite, rating, mime; shared serialisation to query string so any page's filters are deep-linkable.
- **AI side-rail `<AssetAskPanel>`** — a slide-in right-rail that accepts the current page's `contextAssetIds` (filtered/selected) and posts to a chat endpoint with that scope. One implementation, mounted by the toolbar's "Ask" button, available on every asset page.
- **URL-state hook `useToolbarState(page)`** — single source of truth: reads/writes `?q=&sort=&type=&from=&to=&color=&fav=&rating=&density=&view=` and hydrates the toolbar. Makes every list deep-linkable + back/forward-correct.
- **Persistent layout shell** — current pages reimplement `space-y-6 / flex justify-between` headers. Move into `app/(app)/app/layout.tsx` so toolbars become sticky and content scrolls under them.

## Bugs spotted in passing

- `photo-card.tsx:184` — `animate-pulse` triggers for any non-"ready" state, including terminal ones like "captured". Filter to `processing|queued|analyzing`.
- `photo-card.tsx:188` — thumbnail spinner flashes for non-image rows for one frame before `setLoading(false)` runs (effect skips, state still `true` initially).
- `search/page.tsx:242` — `onChange` fires `doSearch` on every keystroke with no debounce; under load this races and the wrong response may win.
- `documents/page.tsx:160-163` — when `subtypeFilter` is set, server response is trusted without re-filtering by mime; an image classified as "scan" will appear in Documents.
- `dashboard/page.tsx:217` — `fetchRecentUploads` re-uses the unfiltered `/assets` then `.slice(0,8)`; pulls the entire library to show 8 thumbs.
- `collections/page.tsx:25-40` — `CollectionCover` does 2 chained `fetch`es per card with no cancellation on quick navigation away.
- `folders/page.tsx:132` — fetches *all* assets in workspace on every folder navigation.
- `map/page.tsx:307-320` — `lightboxAsset` is recomputed on every render; lightbox `filename` falls back to `assets[i].id` (UUID shown to user).
