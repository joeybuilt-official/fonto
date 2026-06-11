# Plan — Fonto End-to-End UI/UX/Functionality Audit & Fix

**Goal:** Audit every Fonto surface (web + native Flutter) through 7 lenses against live myfonto.com, produce a severity-ranked `audit-findings.md`, gate on operator approval, then fix in severity order with smallest changes.

ADR: `adr/0008-uiux-audit-methodology.md`. Findings deliverable: `audit-findings.md`. Checklist: `checklist-uiux-audit.md`.

**Hard rule:** Phases 0–4 are read/screenshot/observe ONLY — zero source edits. Phase 5 is a ⚠ one-way operator gate. No fixes (Phase 6+) until operator approves the findings doc.

**Surfaces under audit:**
- Web authed app (31): home, library, photos, timeline, search, explore (+places, +places/[name], +things), map, memories, people (+[id], +ignored), collections (+[id]), folders, documents, stacks (+[id]), projects (+[id]), imports, trash, updates, settings (+members, +tokens, +webhooks, +audit), admin/jobs.
- Web public/edge (6): `/` landing, `(auth)/login`, `share/[token]`, `invitations/[token]`, `docs/api`, plus `(app)/layout` shell.
- Native Flutter (15): home, library(filtered_assets), explore, search, collections, asset_detail, people(ignored_people), settings, imports, transfers, updates, login, google_drive_import, google_photos_import, nextcloud_import.
- Reusable components (web): app-shell, app-sidebar, app-mobile-bottom-bar, app-mobile-avatar-menu, confirm-button, document-viewer, ui/{button,badge,popover}, theme-toggle, plexo-connection-status.

**Lenses (per operator brief):** 1 Functionality · 2 States (empty/loading/error/partial/ideal) · 3 Interaction · 4 Visual consistency · 5 Accessibility · 6 Responsive (360/768/1024/1440) · 7 Performance & polish.
**Severity:** P0 broken/data-loss/blocked/security-adjacent · P1 works-but-wrong (bad errors, missing states, a11y blockers) · P2 inconsistency/confusion/polish users notice · P3 nice-to-have.

---

## Phase 0 — Inventory & harness verification
- Scope: Finalize the screen/flow/component/role inventory (above) into `checklist-uiux-audit.md`. Verify the Playwright authed session works against `https://myfonto.com` (one authed screenshot of an app screen proves it); if stale, re-mint before trusting any capture. Confirm webtop Chrome availability (server-side browser, CLAUDE.md §0-A) for interactive lenses. Identify user roles/permission states (workspace owner vs member vs share-viewer).
- Deps: none
- Subagents: none (main thread; small)
- Exit: inventory checklist written; one verified authed app-screen screenshot captured proving the harness; role/permission states enumerated.
- Status: done

## Phase 1 — Web authed audit, batch A (media-core surfaces)
- Scope: 7-lens audit of home, library, photos, timeline, search, explore (+places, +places/[name], +things), map, memories. Capture at 360/768/1024/1440; record console errors + failed network requests; exercise primary actions (filter, select, open asset detail). Induce non-ideal states where cheap (throttle, empty filter). Append raw findings to `audit-findings.md`.
- Deps: Phase 0
- Subagents: per-screen capture batches (general-purpose) + Explore for source file:line backing each finding
- Exit: every batch-A screen has a 7-lens pass recorded with screenshots + file refs in findings.
- Status: done

## Phase 2 — Web authed audit, batch B (management/CRUD surfaces)
- Scope: 7-lens audit of people (+[id], +ignored), collections (+[id]), folders, documents, stacks (+[id]), projects (+[id]), imports, trash, updates, settings (+members, +tokens, +webhooks, +audit), admin/jobs. Same lens + breakpoint + console/network protocol. Exercise CRUD round-trips (create/edit/delete collection, token, webhook) and confirm rollback on failure. Append to findings.
- Deps: Phase 0 (independent of Phase 1)
- Subagents: per-screen capture batches + Explore for source backing
- Exit: every batch-B screen 7-lens pass recorded; CRUD round-trips + destructive-action confirms verified.
- Status: done

## Phase 3 — Web public/edge + cross-cutting
- Scope: `/` landing redirect, `(auth)/login` (validation, error copy, double-submit, CORS apex behavior), `share/[token]` public viewer (valid/expired/invalid token states), `invitations/[token]` accept flow, `docs/api`, the `(app)/layout` shell (sidebar/bottom-bar/avatar-menu across breakpoints), reusable components' five states, and a keyboard-only + focus-visible + contrast a11y sweep across primary flows. Append to findings.
- Deps: Phase 0
- Subagents: Explore for component source; capture batches for edge-state screenshots
- Exit: auth + share + invite flows audited incl. error/empty states; component-state matrix + a11y sweep recorded.
- Status: done

## Phase 4 — Native Flutter mobile audit
- Scope: 15 Flutter screens via adapted lens set (Functionality, States, Interaction incl. ≥44px touch targets, Visual consistency, a11y semantics, web parity per parity memory; skip web-only console/network/responsive-breakpoint). Static review of each `*_screen.dart`; emulator screenshots if a build/device is reachable, else static-only with that limitation noted. Flag parity gaps where a web landing surface changed but mobile didn't. Append to findings.
- Deps: Phase 0
- Subagents: Explore for screen source + state/widget review
- Exit: every Flutter screen reviewed; parity-gap list recorded; emulator availability noted.
- Status: done

## Phase 5 — Consolidate findings + OPERATOR GATE ⚠
- Scope: De-dupe, severity-rank (P0→P3), and finalize `audit-findings.md` in the operator's required entry format (title, screen/route, repro, expected, actual, files, fix approach). Present the findings doc to the operator and **STOP**.
- Deps: Phases 1–4
- Subagents: none
- Exit: `audit-findings.md` complete and presented. ⚠ **One-way door / operator sign-off gate — HARD STOP. No fixes until operator types approval.**
- Status: done

## Phase 6+ — Fix (post-approval)
- Scope: Fix in strict severity order, one issue at a time, smallest change that resolves it. No drive-by refactors, no redesigns, no new deps without asking. Verify each fix in the running app + re-test adjacent screens for regressions. Update the issue's status in `audit-findings.md` immediately (not batched). Surface any A-breaks-B conflict instead of choosing silently. Ship gate (tests pass, types clean, build green) before any push; push is operator-authorized.
- Deps: Phase 5 approval
- Subagents: general-purpose for multi-file fixes; Explore for impact analysis
- Exit: all approved findings resolved + verified; status updated throughout.
- Status: COMPLETE — all P0/P1/P2/P3 resolved (fixed or closed-with-reason). Final P3s closed 2026-06-10 (docs/api CDN fallback, mobile folder back-button; share Escape/attempts = won't-fix N/A). Web deployed myfonto.com @ ac72e2a + live-verified; mobile changes in APK tags through v2.0.347. Audit done.
