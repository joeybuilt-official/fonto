# Photos vs Files — Structural Library Split

Status: **DRAFT — awaiting operator approval**. No app code written until approved.
Owner: Fonto. Repos: `/workspace/fonto` (mobile + web + classifier). Date: 2026-06-22.
Feature flag: `LIBRARY_SURFACE_SPLIT_ENABLED` (server env, default OFF in prod).

---

## 1. Panel summary

Six-expert panel convened. The unanimous read: the existing `kind` partition is already semantically a two-type system — **camera-origin media** (moment, video) vs **synthetic/imported artifacts** (screenshot, graphics, document) — but it is presented as one flat row of peer lens chips, which under-sells the difference and forces one UX (square photo grid + immersive viewer + on-device camera-roll strip) onto file-shaped content that wants a different one (list rows + filename/OCR search + properties pane).

Promoting the split to a structural segmented control is endorsed by all six, with the following caveats that shaped the decisions below:

- **Asset-management SME:** the moment↔file boundary is real to users (they *browse* photos, they *retrieve* files), but the classifier's `moment` is also the fallback bucket — so "moment" is not a clean signal, and NULL/unclassified must be handled deliberately, not dumped on Photos silently.
- **Mobile interface engineer:** the on-device `DeviceKind` resolver cannot produce `document` (device_kind.dart:48-62), so an "on-device" strip on the Files surface would be structurally incomplete and misleading; it must be Photos-only in v1.
- **Full-stack engineer:** the API already supports both required sort modes and every column the Files properties pane needs — **no schema migration, no new endpoint**. The whole split is a presentation-layer change plus a feature flag.
- **Visual designer:** segmented control must read as a mode switch (two equal-weight surfaces), distinct in affordance from the lens chips below it (sub-filter within a surface). Different control shape, not just a longer chip row.
- **UI/UX lead:** parity is non-negotiable; mobile state and web URL must encode the same `(surface, lens)` tuple so a deep link and an app cold-launch land in the same place.
- **Devil's advocate:** see §9 risk register. Primary concerns: NULL-kind regression, the png→moment mislabel population moving surfaces under users during the sweep, and search scoping creating "I can't find my screenshot" dead-ends.

**Conclusion:** ship behind a flag, parity in lockstep, no classifier rule changes, no migration, sweep AFTER the UI ships and is validated but BEFORE flag default-ON.

---

## 2. Decision matrix

| # | Decision | Resolution | Reason (panel) |
|---|----------|-----------|----------------|
| 1 | Where NULL-kind lands | **C (operator decision): separate "Inbox" pseudo-surface ABOVE the segmented control.** Inbox = `kind IS NULL`. Shows a count + entry only when non-empty; hides itself once the sweep drains NULL to zero. NULL excluded from both Photos and Files. | Operator override (2026-06-22). Most honest: unclassified is visibly its own holding area, never silently mixed into Photos. Two-surface segmented control stays clean (Inbox is a banner/entry, not a third segment). Self-hiding when empty → no permanent UI cost post-sweep. |
| 2 | Default surface, cold launch | **Photos on true first launch; otherwise last-used, persisted.** | Photos dominate 176k:37k. Power users who live in Files shouldn't re-toggle every launch. Mirrors mobile `settings_store` pattern (new key) and web localStorage + URL. |
| 3 | On-device strip on Files | **Hidden entirely in v1.** | `DeviceKind` cannot resolve `document` (device_kind.dart) → strip would silently omit a whole lens. "On this device" camera-roll framing fits photos, not imported artifacts. Matches the mockup (strip is Photos-only). Revisit in v2 if users ask. |
| 4 | Web URL scheme | **`?surface=photos\|files` query param, layered with existing `?kind=` (now scoped as the lens) and `?lb=`.** | Page already uses query params (`?kind=`, `?lb=`); a path split (`/library/photos`) means a route restructure + duplicate page for no bookmarkability gain. Query param = minimal diff, deep-linkable, 1:1 with mobile state. |
| 5 | Search scoping | **Two scoped searches. Photos = OCR + visual + person/place (existing). Files = SERVER-SIDE search over filename + OCR text + source-app (operator decision — built this task, not deferred). No new global cross-surface search — the existing Search bottom-nav tab remains the cross-kind escape hatch.** | Result rendering differs (grid vs list); a unified result set would be incoherent. Global search already exists. Dead-end risk mitigated by the global Search tab staying cross-kind + empty-state cross-links. Operator override (2026-06-22): Files search is server-side from day one, not client post-fetch. |
| 6 | Sort defaults | **Photos = captured-at DESC (`sort=captured`, COALESCE(captured_at, created_at)). Files = imported-at DESC (`sort=created`, the API default).** | Matches mockup and existing API capability (route.ts:223-227). No API change. |
| 7 | Properties / detail divergence | **Photos → existing immersive `AssetDetailScreen` / web lightbox (unchanged). Files → properties sheet (mobile bottom sheet, web modal/right pane).** v1 fields: preview thumbnail, filename, kind, captured-at, imported-at, source/source-app, OCR text excerpt (collapsible), "Open folder" (links to `?directoryPath=`). Deferred: "Send to…", "Show in OS folder". | All fields exist as columns. "Open folder" is cheap (directoryPath present) and high-value for retrieval. Heavier actions deferred to keep v1 minimal. |
| 8 | Bottom-nav impact | **Unchanged — 5 items (Library / Explore / Collections / Updates / Search). Segmented control lives inside Library.** | Confirmed against main_shell.dart:87-112. No nav churn. |
| 9 | Sweep timing | **After the UI ships behind the flag AND the operator validates locally, but BEFORE flipping the flag default-ON in prod. Run off-hours.** | The sweep moves assets between surfaces (NULL→classified, png-moment→screenshot/graphics). With the flag OFF in prod, the sweep has zero user-facing race. Running it while users browse a live split would make assets jump surfaces mid-session. Operator's stated order (sweep → ON) is adopted. |
| 10 | Telemetry | **Fire: `library_surface_toggle {from,to}`, `library_surface_view {surface, dwell_ms}`, `library_lens_select {surface, lens}`, `library_search {surface, query_len, result_count}`, `library_properties_open {kind}`.** Wire to the existing client analytics sink if present; otherwise gate behind the same flag and no-op until a sink exists. | Answers "does the split help": toggle frequency (discovery), dwell (do people use Files?), search-per-surface (is scoped search working?). Minimal payloads, no PII (query_len not query text). |

---

## 3. IA diagram

```
Bottom nav (5, unchanged):  [Library] [Explore] [Collections] [Updates] [Search]
        │
        ▼  Library
  ┌─────────────────────────────────────────────┐
  │  ▸ Inbox (N pending)   ← shown only when N>0  │   ← kind IS NULL; self-hides at N=0
  ├─────────────────────────────────────────────┤
  │  Segmented control (MODE switch)             │
  │      [ 📷 Photos ]   [ 📄 Files ]            │   ← surface (default Photos / last-used)
  ├─────────────────────────────────────────────┤
  │  Lens chips (SUB-filter, surface-scoped)     │
  │   Photos:  All · Moments · Videos            │
  │   Files :  All · Screenshots · Graphics · Documents
  ├─────────────────────────────────────────────┤
  │  PHOTOS surface             FILES surface     │
  │  • search: OCR+visual       • search bar pinned (filename+OCR+source)
  │  • "On this device" strip   • (no device strip)
  │  • monthly timeline bands   • recency bands (This week / Earlier)
  │  • 3-col square grid        • LIST rows (icon + filename + OCR snippet + date)
  │  • year scrubber (right)    • imported-at DESC
  │  • captured-at DESC         • tap → Properties sheet
  │  • tap → immersive viewer   •
  └─────────────────────────────────────────────┘

kind → surface map:
  moment ─┐
  video  ─┴─► PHOTOS         (NULL ─► PHOTOS, "All" lens only, "Pending" badge)
  screenshot ┐
  graphics   ├─► FILES
  document   ┘
  NULL ─► INBOX (pseudo-surface above the segmented control; self-hides when empty)
```

---

## 4. Data model deltas

**None.** Verified against `lib/db/schema.ts`:
- `kind` (text, enum moment|screenshot|graphics|document|video) — line 288.
- `filename` (96), `mime_type` (97), `captured_at` (112), `created_at` (203 — imported-at), `ocr_text` (125), `source` (103 — source-app), `directory_path` (222 — "Open folder").
- Indexes already present: `assets_workspace_kind_idx` (partial, active) 376-378; `assets_workspace_captured_at_idx` 337-340.

**API changes (additive, back-compatible):**
- `?kind=` accepts a comma list → `inArray(assets.kind, kinds)` (single value still works).
- `?unclassified=1` → `isNull(assets.kind)` (drives the Inbox surface).
- `?q=` becomes **server-side** for Files: `or(ilike(filename,%q%), ilike(ocr_text,%q%), ilike(source,%q%))` pushed into the DB WHERE (operator decision — replaces the client post-fetch for the Files surface). Photos search path unchanged.

---

## 5. UI inventory deltas

### Mobile (`mobile/`)
- `home_screen.dart`:
  - New enum `LibrarySurface { photos, files, inbox }`; new state `_surface`. Segmented control renders only photos/files; `inbox` is entered via a banner above it (shown only when pending>0) and exits back to the prior real surface.
  - Refactor `_LensSelector` (1287-1294) → `_SurfaceSelector` (segmented control) + `_LensChips` (surface-scoped chip list).
  - Lens lists become surface-scoped:
    - Photos: `[("all","All"), ("moment","Moments"), ("video","Videos")]`
    - Files: `[("all","All"), ("screenshot","Screenshots"), ("graphics","Graphics"), ("document","Documents")]`
  - `?kind=` mapping: Photos "All" → `kind=moment,video` (needs multi-kind support — see note); Files "All" → `kind=screenshot,graphics,document`. Specific lens → single kind as today.
  - On-device strip (`_deviceSlivers()` 1020-1078): render only when `_surface == photos`.
  - Default `_lens` switches with surface; reset to "all" on surface change.
  - Files list rows: new `_FileRow` widget (icon + filename + OCR snippet + imported date). Recency band headers ("This week"/"Earlier") from `created_at`.
  - Tap on Files row → new `_FilePropertiesSheet` (bottom sheet) instead of `AssetDetailScreen`.
- `device_kind.dart`: no change (Files strip hidden, so `document` gap is moot).
- `settings_store.dart`: add `_kLastSurface` ("fonto.last_surface") + `_kLastLensPhotos` / `_kLastLensFiles` (optional — persist last lens per surface). Minimal v1: persist surface only.
- `fonto_client.dart` `listAssets()` (129-154): support comma-joined `kind` (multi-kind "All" surfaces) and `sort` already param. Add `q` passthrough for Files.

### Web (`app/(app)/app/library/page.tsx`)
- Split `LENSES` (74-81) → `PHOTO_LENSES` + `FILE_LENSES`.
- Add `<SurfaceSegmentedControl>` above the chip row.
- Read/write `?surface=` in searchParams alongside `?kind=`; persist last surface to localStorage; surface change resets lens to "all".
- "All" lens per surface → multi-kind fetch (see note).
- Files surface: pinned search bar, list-row renderer (`<FileRow>`), recency bands, Properties modal (reuse lightbox routing pattern with `?props=<id>` instead of `?lb=<id>`).
- Photos surface: unchanged (timeline, scrubber, grid, lightbox).

### API note — multi-kind "All", Inbox, server search
route.ts:285 currently does `eq(kind, kindFilter)` (single). Three additive, back-compatible changes:
1. Accept comma-separated `?kind=moment,video` → `inArray(schema.assets.kind, kinds)` (single value still works). Validate each token via `isKind()`.
2. `?unclassified=1` → `isNull(schema.assets.kind)`. Drives the **Inbox** surface. NULL is NOT folded into Photos/All (operator decision 1 = Inbox). Photos/All = `inArray(kind, [moment,video])` only.
3. `?q=` server-side: `or(ilike(filename), ilike(ocr_text), ilike(source))`. Used by the Files surface (operator decision 5). Photos search path unchanged.

---

## 6. Migration of existing user state (last-used lens)

- Mobile today: `_lens` always defaults to "moment", nothing persisted (home_screen.dart:103).
- Web today: lens from `?kind=` URL or default "moment".
- New behavior: on first run post-update there is no persisted surface → default Photos, lens "All". Old `?kind=` deep links still resolve: map the kind to its owning surface (e.g. `?kind=screenshot` → surface=files, lens=screenshot) so existing bookmarks/links don't break. This back-compat mapping is the migration; no stored data to migrate.

---

## 7. Telemetry plan

Events + payloads (see decision 10). Implementation: a single `trackLibrary(event, props)` helper on each platform that forwards to the existing analytics sink if one exists; if none exists, it is a no-op behind `LIBRARY_SURFACE_SPLIT_ENABLED`. No new backend. Verify during implementation whether an analytics client already exists (grep for existing track/analytics calls); if absent, v1 ships the call sites wired to a no-op and we add a sink later. Query text is never sent (only `query_len`).

---

## 8. Rollout sequencing

1. Implement mobile + web behind `LIBRARY_SURFACE_SPLIT_ENABLED` (single PR per repo). Flag OFF → exact current Library behavior (one flat lens row). Flag ON → segmented surfaces.
2. `flutter analyze` on a `/tmp` copy of `mobile/` (Codemagic analyze is zero-tolerance for info findings).
3. Tag `v2.0.363` candidate (flag OFF in prod). Codemagic `v*` → APK/AAB emailed to operator.
4. Operator installs, flips flag locally, validates on device + web at 390px and desktop.
5. Operator runs `scripts/photos-vs-files-presplit-sweep.ts` (this session produces it; operator invokes — drains NULL, reclassifies png-moments) off-hours.
6. Operator flips `LIBRARY_SURFACE_SPLIT_ENABLED` default ON in prod.

Sweep is §3-of-deliverables; **not run in this session**.

---

## 9. Risk register (devil's-advocate items)

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **NULL-kind regression** — 5,113 NULL assets become invisible. | High | Dedicated **Inbox** surface (`?unclassified=1`) surfaces all NULL with a count; self-hides only at 0. e2e asserts NULL count appears in Inbox. |
| **Surface-jump during sweep** — png-moment → screenshot/graphics moves ~? assets from Photos to Files; if done with flag ON live, users see assets vanish from Photos mid-session. | High | Sweep runs while flag is OFF in prod (decision 9). Sequencing §8 enforces order. |
| **Classifier is wrong before split lands** — if a whole category is mis-kinded, the split surfaces the error structurally. | Med | This task does NOT touch `lib/classify/kind.ts`. If exploration/QA reveals systemic mis-kind, STOP and surface to operator (per task constraint) — do not silently re-tune. |
| **"Can't find my screenshot" dead-end** — scoped search hides cross-surface results. | Med | Empty-state in each surface search links to "Search all" (global Search tab). Global tab stays cross-kind. |
| **Multi-kind "All" perf** — `inArray` over kind without the right index. | Low | `assets_workspace_kind_idx` is `(workspace_id, kind)` partial-active; `inArray` uses it. Verify EXPLAIN in QA. |
| **Mobile "All" Photos vs device strip mismatch** — strip shows device tiles whose DeviceKind ≠ server kind. | Low | Strip already lens-filtered (4719a86); on Photos/All, strip shows moment+video+png-as-screenshot device tiles → acceptable provisional; documented. |
| **Parity drift** — web ships, mobile lags. | Med | Single converged plan; both PRs gated together; e2e (web `e2e/audit/12-library-files.spec.ts`) + documented mobile QA (`mobile-qa.md`) before tag. Operator rejects single-platform ship. |
| **Files list payload bloat** — the list response includes `ocr_text` (large for documents) for the snippet/search-context. | Low | Files counts are modest (~37k total, page of 200) and v1 ships as-is; client truncates the display to ~120 chars. v2 optimization: a slim `fields=` projection or a server-side `ocr_snippet`. Logged, not blocking. |
| **Files surface is online-only in v1** — no offline cache (Photos keeps its cache). | Low | Files is retrieval, not browse; acceptable v1. Documented in `mobile-qa.md` step 5. |
| **Flag half-applied** — server reads flag but client doesn't, or vice versa. | Med | Flag is read once server-side and exposed to web client via existing config pattern; mobile reads it from a `/api/health`-style config field (the app already fetches base config). If mobile cannot read a server flag pre-login, fall back to a compile-time const defaulting OFF and flip via app config endpoint. Resolve exact mechanism in implementation step 1. |
| **`?kind=` deep-link breakage** | Low | Back-compat mapping kind→surface (§6). |

---

## 10. Open implementation questions (resolve at code time, not blocking approval)

- Exact mechanism for mobile to read `LIBRARY_SURFACE_SPLIT_ENABLED` (server config field vs compile-time const). Leaning: expose in the existing app-config/health payload the app already fetches.
- Whether an analytics sink exists (grep at code time); if not, no-op call sites.
- Whether Files search stays client-side post-fetch (v1) or needs server-side `ocr_text` search (v2 trigger: list feels incomplete at scale).
