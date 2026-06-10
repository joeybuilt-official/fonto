# Checklist — Fonto UI/UX Audit & Fix

Plan: `plan-uiux-audit.md` · ADR: `adr/0008-uiux-audit-methodology.md` · Findings: `audit-findings.md`

## Phase 0 — Inventory & harness
- [x] Inventory finalized in this checklist (screens/flows/components/roles below)
- [x] Playwright authed session verified vs https://myfonto.com (200, ws "Personal")
- [x] Server-side chromium (/usr/bin/chromium) confirmed for headless capture
- [x] Roles/permission states enumerated (owner / member / share-viewer)
- [x] Harness proven — run-audit-full.mjs capturing all routes ×4 breakpoints

## Phase 1 — Web authed batch A (7 lenses @ 360/768/1024/1440)
- [x] home
- [x] library
- [x] photos
- [x] timeline
- [x] search
- [x] explore
- [x] explore/places + explore/places/[name]
- [x] explore/things
- [x] map
- [x] memories

## Phase 2 — Web authed batch B
- [x] people + people/[id] + people/ignored
- [x] collections + collections/[id]
- [x] folders
- [x] documents
- [x] stacks + stacks/[id]
- [x] projects + projects/[id]
- [x] imports
- [x] trash
- [x] updates
- [x] settings + members + tokens + webhooks + audit
- [x] admin/jobs
- [x] CRUD round-trips + destructive-confirm verified

## Phase 3 — Public/edge + cross-cutting
- [x] / landing redirect
- [x] login (validation, error copy, double-submit, www→apex)
- [x] share/[token] (valid / expired / invalid states)
- [x] invitations/[token] accept flow
- [x] docs/api
- [x] (app)/layout shell: sidebar / mobile-bottom-bar / avatar-menu across breakpoints
- [x] reusable components five-state matrix (button, badge, popover, confirm-button, document-viewer, theme-toggle, plexo-status)
- [x] a11y sweep: keyboard nav, focus-visible, contrast, landmarks on primary flows

## Phase 4 — Native Flutter mobile (adapted lenses)
- [x] home
- [x] library / filtered_assets
- [x] explore
- [x] search
- [x] collections
- [x] asset_detail
- [x] people / ignored_people
- [x] settings
- [x] imports
- [x] transfers
- [x] updates
- [x] login
- [x] google_drive_import
- [x] google_photos_import
- [x] nextcloud_import
- [x] web-parity gap list recorded
- [x] emulator availability noted

## Phase 5 — Consolidate + GATE ⚠
- [x] audit-findings.md de-duped + severity-ranked (P0→P3) in required format
- [x] Findings presented + approved (fix everything); Phase 6 executed

## Phase 6+ — Fix (post-approval, severity order)
- [ ] (populated from approved findings)
