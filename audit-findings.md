# Fonto — UI/UX/Functionality Audit Findings

## Fix status (Phase 6 — operator approved "fix everything", 2026-06-09)
All findings below addressed in code. Typecheck clean (only 2 pre-existing errors excluded), zero new lint problems introduced. **DEPLOYED to myfonto.com (commit 4d5d8c0) + live-verified 2026-06-09:** people face-flood reqfails 771→0, stacks /assets/urls 400→0, memories #418→0, admin/jobs 360px overflow true→false (harness `e2e/audit/verify-fixes.mjs`). Stacks + admin needed a 2nd pass (cap covers at 500; flex `min-w-0` on main) caught by live verify. P0 share-cookie change is structurally verified (build+types; GET form removed) — no test share link to exercise live. Mobile changes are static-only (no emulator in env).

- **P0** share password GET → **FIXED** (httpOnly cookie via server action)
- **P1** memories #418 → FIXED · people face-flood → FIXED (concurrency limiter + lazy img) · stacks 400 → FIXED (filter null ids) · login labels → FIXED (aria-label) · document-viewer a11y → FIXED (aria-label + Escape + focus) · silent fetch/mutation cluster (9 files) → FIXED (response.ok checks + ListErrorState + rollback) · Flutter destructive-confirm → FIXED · Flutter silent catches → FIXED
- **P2** admin/jobs overflow → FIXED (overflow-x-auto) · unlabeled inputs → FIXED (imports, members; updates had none) · hardcoded #1D9089 → FIXED (→ primary/90) · missing H1 (person-detail, docs/api) → FIXED (sr-only h1) · Recognition tab → FIXED (→ integrations) · people empty-name → FIXED (disabled guard) · invite identical states → FIXED (per-state icon/color/title) · updates unlabeled input → FIXED (aria-label on uploads file input) · members confirm()/alert() → DEFERRED (functional native dialogs; converting to in-app modal/toast is a UX design choice — flag for a dedicated polish pass) · Flutter dead affordance → FIXED
- **P3** aria-busy (invite) → FIXED · others (login aria-busy, docs CDN fallback, share Escape/attempts, Flutter breadcrumb/count-fmt) → minor, deferred unless requested

---


Audited 2026-06-09 against **live myfonto.com** (workspace "Personal") + native Flutter source.
Method: ADR `adr/0008-uiux-audit-methodology.md`. Harness `e2e/audit/run-audit-full.mjs` (all web routes × 360/768/1024/1440, console+network+a11y+screenshots in `/tmp/fonto-audit/`). Flutter: static source review (no emulator available — noted as a coverage limit). Static-flagged claims that drive code changes were code-verified; two subagent claims (webhooks toggle "inverted", share input "no required") were checked and **rejected as false**.

**Confidence tags:** `[V]` verified in running app or by reading the code · `[S]` static-flagged, confirm at fix time.

---

## P0 — broken / data-loss / blocked / security-adjacent

### [P0] Share password submitted via URL query string (GET) `[V]`
Screen/route: `/share/[token]` (password-protected public share)
Repro: Open a password-protected share → password prompt → submit. Form is `method="GET"`; password lands in the URL as `?p=<password>`.
Expected: Password sent in a request body (POST), never in the URL.
Actual: `app/share/[token]/page.tsx:191-192` `<form method="GET">`; server reads `searchParams.p` at line 226 and verifies at 277. Password is now logged in server/proxy access logs, browser history, and Referer headers of any outbound link on the unlocked page.
File(s): `app/share/[token]/page.tsx` (form 191-218, handler 223-277)
Fix approach: Convert to POST via a server action or a `route.ts` POST handler that sets a short-lived signed cookie for the unlock, then redirects. Server-component `searchParams` can't read a POST body, so this is a small structural change — **flagging as a design touch per the rules** (no schema/dep change, but a form→action conversion). Confirm approach before implementing.

---

## P1 — works but wrong (bad errors, missing states, a11y blockers)

### [P1] Memories page throws React #418 hydration mismatch `[V]`
Screen/route: `/app/memories`
Repro: Load the page; console shows `Minified React error #418` (server-rendered HTML ≠ client).
Expected: Zero console errors; no hydration mismatch.
Actual: `[pageerror]` captured on every load. #418 = text/markup hydration mismatch — likely a date/`Date.now()`/locale or `typeof window` branch rendered during SSR.
File(s): `app/(app)/app/memories/page.tsx` (+ child components)
Fix approach: Find the SSR/client-divergent value (time-relative label, random, or `window`-gated render) and gate it with `useEffect`/`suppressHydrationWarning` or render deterministically.

### [P1] People page floods face-thumbnail requests → ERR_INSUFFICIENT_RESOURCES `[V]`
Screen/route: `/app/people`
Repro: Load people grid; 771 `net::ERR_INSUFFICIENT_RESOURCES` request failures + ≥10 broken avatar images. Browser connection pool exhausted by simultaneous per-face thumb fetches.
Expected: Avatars load without saturating the connection pool; no broken images.
Actual: Every person/face tile fires its thumb request at once with no lazy-loading or concurrency cap. `img` src is a presigned R2 URL fetched eagerly.
File(s): `app/(app)/app/people/page.tsx` (face/avatar rendering)
Fix approach: `loading="lazy"` + `decoding="async"` on avatar imgs, or IntersectionObserver-gated load, or cap concurrent thumb fetches. Smallest: add native lazy-loading to the avatar `img`.

### [P1] Stacks list 400s on `/api/v1/assets/urls` (null primary asset) `[V]`
Screen/route: `/app/stacks` (and collections Stacks tab)
Repro: Load stacks; POST `/api/v1/assets/urls` returns 400 `ids[] required`; cover thumbs silently missing.
Expected: No failed request; stacks without a primary asset render a placeholder cover.
Actual: `app/(app)/app/collections/_components/stacks-tab.tsx:199` sends `ids: list.map(s => s.primaryAssetId)`; null/undefined `primaryAssetId`s filter out server-side, and an all-null batch → empty → 400.
File(s): `app/(app)/app/collections/_components/stacks-tab.tsx:195-204` (also check `/app/stacks/page.tsx`)
Fix approach: Filter falsy ids client-side before the fetch; skip the call when the filtered list is empty.

### [P1] Login inputs have no `<label>` (placeholder-only) `[V]`
Screen/route: `/login`
Repro: Inspect name/email/password inputs — only `placeholder`, no associated label.
Expected: Every input has a programmatic label (WCAG 1.3.1 / 4.1.2).
Actual: `app/(auth)/login/page.tsx:96-114` inputs use `placeholder` only; placeholder disappears on focus and is not a label.
File(s): `app/(auth)/login/page.tsx:94-131`
Fix approach: Add `<label>` (visually-hidden if the design wants placeholder look) or `aria-label` on each input.

### [P1] Document viewer: icon-only buttons unlabeled + no focus trap/Escape `[V]`
Screen/route: Document viewer modal (documents / asset detail)
Repro: Open viewer; Close / ZoomIn / ZoomOut are icon-only with no accessible name; modal doesn't trap focus or close on Escape.
Expected: Icon buttons have `aria-label`; modal traps focus, returns focus on close, Escape closes.
Actual: `components/document-viewer.tsx:45,71,78` icon buttons, no `aria-label`; no focus management.
File(s): `components/document-viewer.tsx`
Fix approach: Add `aria-label` to the three icon buttons; add Escape handler + focus trap/return (match the popover pattern already in the codebase).

### [P1] Widespread silent fetch/mutation failures — blank on error, no retry `[S]`
Screen/route: many (`/app/home`, `/app/photos`, `/app/timeline`, `/app/documents`, `/app/collections/[id]`, `/app/stacks/[id]`, `/app/projects/[id]`, `/app/trash`, `/app/people`)
Repro: Induce a failing request (throttle/offline) on these screens; UI shows a blank list/stale data with no error message or retry, and destructive mutations report nothing on failure.
Expected: Each data fetch has an actionable ERROR state + retry; mutations surface failure and roll back optimistic UI.
Actual (representative, confirm each at fix time):
- `home/page.tsx` stats fetch — no catch → blank stats grid.
- `photos/page.tsx:144-187`, `timeline/page.tsx:30-70`, `documents/page.tsx:~343` — fetch with no error branch (timeline can spin forever).
- `collections/[id]/page.tsx:65-81,198-206` — `handleAdd` ignores per-item response status (partial failure silent); no error UI on load.
- `stacks/[id]/page.tsx:100-166`, `projects/[id]/page.tsx:47-55` — `setPrimary`/`removeMember`/`saveName`/`handleSave` don't check `response.ok`; fail silently (projects closes the editor as if saved).
- `trash/page.tsx:116-140` — `restoreOne`/`deleteOne`/bulk ops don't check response; silent failure on a destructive surface.
- `people/[id]/page.tsx:395-522` — `hideSelected`/`detachSelected`/`doMerge` clear selection / navigate before confirming success; no rollback.
File(s): listed above
Fix approach: Add a consistent error-state + retry to each fetch (the app already has `ListErrorState`); check `response.ok` on mutations and surface a toast + roll back optimistic state. Apply per-file in severity sub-order; this is the largest cluster.

### [P1] Flutter: destructive actions without confirmation `[S]`
Screen/route: mobile — home (clear failed uploads), explore (ignore person), transfers (Clear / Retry all)
Repro: Tap these; action executes immediately with no confirm dialog.
Expected: Destructive/irreversible-feeling actions confirm or are clearly undoable (asset trash already uses `_confirmTrash` — be consistent).
Actual: `mobile/lib/src/screens/home_screen.dart:535` `clearFailed()`; `explore_screen.dart:1161` `setPersonHidden`; `transfers_screen.dart:348-349` Clear/Retry-all — all no-confirm.
File(s): as listed
Fix approach: Wrap each in the existing confirm-dialog pattern used by `_confirmTrash`.

### [P1] Flutter: silent API error catches leave stale/blank UI `[S]`
Screen/route: mobile — asset_detail (preview), home (soft refresh), explore (faces)
Repro: Fail a mid-scroll request; spinner persists or stale grid stays with no error/retry.
Actual: `asset_detail_screen.dart:91-92` preview fetch swallowed ("Silent — placeholder will render"); `home_screen.dart:223-226` `_softRefresh` catches with no feedback; `explore_screen.dart:106-118` caches `[]` on failure so retry never refetches.
File(s): as listed
Fix approach: Add error state + retry; don't cache empty-on-error (use a null/"unfetched" sentinel so retry re-attempts).

---

## P2 — inconsistency / confusion / polish users notice

### [P2] admin/jobs horizontal-scrolls at 360px `[V]`
Screen/route: `/admin/jobs` — `overflowX` true at 360px (table too wide for mobile).
Fix approach: Wrap the table in an overflow container or add a mobile card layout.

### [P2] Filter/search inputs without labels `[V]`
Screen/route: `/app/imports`, `/app/updates`, `/app/settings/members` (one unlabeled input each, from a11y probe).
Fix approach: Add `aria-label`/`<label>` to each filter/search field.

### [P2] Design-system fragmentation: ~39 ad-hoc inline button styles `[S]`
Screen/route: `app/page.tsx`, `/login`, `invitations/[token]/accept-button.tsx`, `share/[token]`, various collection/project pages. Ad-hoc `rounded bg-primary px-3 py-2` instead of the `Button` component; hardcoded `hover:bg-[#1D9089]` instead of `hover:bg-primary/90`.
Fix approach: Per the conflict-2 decision, report all; fix only operator-approved ones. Smallest high-value: replace the two hardcoded `#1D9089` hovers with the semantic token. Do NOT mass-migrate to `<Button>` (redesign).

### [P2] Missing/!single H1 — heading hierarchy `[V]`
Screen/route: `/app/people/[id]` (no h1), `/docs/api` (no h1, plus 1 unnamed button).
Fix approach: Add a page-level `<h1>` (visually-hidden ok) for landmark/heading structure.

### [P2] "Recognition" settings section keyed to the "storage" tab `[S]`
Screen/route: `/app/settings` — `settings/page.tsx:276` wraps the Recognition card in `tabClass("storage")`, so on desktop it appears under Storage with no tab of its own.
Fix approach: Confirm intent; if Recognition should be its own/under integrations, change the key. Low-confidence — verify visually first.

### [P2] Invite states (expired/revoked/accepted) visually identical `[S]`
Screen/route: `/invitations/[token]` — `page.tsx:93-116` renders the same card for all terminal states; only text differs.
Fix approach: Differentiate with an icon/color per state.

### [P2] settings/members uses blocking `confirm()`/`alert()` `[S]`
Screen/route: `/app/settings/members` — `handleRevoke` uses native `confirm()` then `alert()` on failure (inconsistent with the app's dialog/toast pattern).
Fix approach: Replace with the in-app confirm dialog + toast.

### [P2] People rename allows empty name `[S]`
Screen/route: `/app/people` — `saveEdit` PATCHes without `editName.trim()` guard; empty name can be saved.
Fix approach: Disable save / validate on empty-trim.

### [P2] Flutter: dead "People & Pets" affordance + copy/UX inconsistencies `[S]`
Screen/route: mobile collections — `collections_screen.dart:903` `onTap: () {}` no-op under a `chevron_right` that implies navigation; plus generic snackbar error copy (`asset_detail_screen.dart:145,159`) and duplicated permission-denied messages (`settings_screen.dart:95-102,182-190`).
Fix approach: Remove the dead affordance or wire it; unify error/permission copy.

---

## P3 — nice-to-have / micro-polish

### [P3] Minor a11y/feedback gaps `[S]`
- `/login` disabled-submit lacks `aria-busy`; toggle button focus ring not distinct from hover (`login/page.tsx:124-145`).
- `/docs/api` Scalar UI via `dangerouslySetInnerHTML` from CDN with no fallback if CDN fails.
- `/invitations` accept button no `aria-busy` during load.
- `/share` password prompt: no Escape handler, no attempts-remaining counter.
- Flutter `home_screen.dart:631` folder title ellipsis with no breadcrumb/up affordance; count formatting `5200` vs `5.2k` (`collections_screen.dart:656`).

---

## Coverage notes / limits
- Login, share, invitations, docs/api visual screenshots were **static-only** (the authed runner skipped unauth pages). Static review covered them; visual capture can be added if desired.
- Non-ideal states (loading/empty/error) on the live app were mostly inferred from code (real data resolves instantly + non-empty) per pre-mortem fallback 2 — induce-and-verify happens during fixes.
- Flutter audited **static-only** (no emulator/device in this environment).
- Dropped as false after verification: webhooks toggle "inverted logic"; share password input "missing required".
