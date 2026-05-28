# Fonto UX consolidation — follow-up master plan

Sibling to `plan-ux.md` (the parent UX consolidation, phases 1–7a
shipped 2026-05-27). This file scopes the three deferred workstreams
captured in `checklist-ux.md` at session-end: Phase 7b, Phase 4.1,
and Phase 1.1.

## Goal

Close the three follow-up threads that descended from the parent
plan: discoverability sub-list under Collections (7b), CLIP
zero-shot verification + corpus-readiness gates (4.1), and Library's
remaining chip-strip primitives (1.1). Each phase fits one session.

## Cross-phase decisions captured in ADR

- `adr/0005-ux-consolidation-followups.md` — sub-list shape,
  verification approach, popover surface choice. Default
  resolutions captured for FU-C1 / FU-C2 / FU-C3.

## Phase 7b — pinned albums under Collections sidebar entry

- Scope: extend `components/app-sidebar.tsx` to render the 3 most
  recent albums (by `createdAt desc`) under the Collections nav
  item as a sub-list. Sub-list uses the same active-state logic
  (prefix-match) — clicking a pinned album highlights both the
  Collections parent and the specific sub-row. SSR the album fetch
  in `(app)/layout.tsx` so first paint has the right data (no
  layout shift).
- Deps: parent plan phase 7a done (commit 924b28d) — already in.
  ADR 0005 FU-C1 default approved.
- Subagents: Explore subagent to confirm there's no existing
  sidebar SSR-prop plumbing — keeps the wiring honest.
- Exit: sidebar shows Collections + 3 indented pinned-album links
  on desktop. Mobile bottom-bar unaffected (the avatar menu + the
  hamburger sidebar drawer also display the pins, but they're
  desktop-primary). No layout shift on first paint.
- Status: **code shipped 2026-05-27** (commit ae3a5d5); deploy
  (`bmt21wcln`) in flight at session-end handoff. First action in
  the next session: `ssh <server> ...docker compose up -d --force-recreate fonto`
  + smoke `/app/library` 307 + sidebar source for pin sub-list
  markup. Then mark the DEPLOY box in checklist-ux-followups.md
  and continue to Phase 4.1.

## Phase 4.1 — CLIP fix verification + corpus gates

- Scope: ship `scripts/verify-clip-classification.ts` (operator-
  runnable: `pnpm verify:clip`) that pushes a known test image
  through the same `processAsset` pipeline and asserts the
  resulting row has `classify_method='clip'`. Document the
  expected output in the script header. Then enqueue the
  `clip_vec` backfill against historical rows
  (`pnpm backfill:clip`) and confirm coverage hits 100% on the
  current corpus. Finally, write a one-shot SELECT that gates the
  Things-tile graduation: when ≥6 classes each have ≥10 members,
  flip the placeholder over to a live class-grid (Phase 4.2 work
  — out of scope here, but the gate query lands so it's
  copy-pasteable when the time comes).
- Deps: CLIP fix commit 6e85410 deployed (worker recreated
  2026-05-27). ADR 0005 FU-C2 default (verify-then-backfill).
- Subagents: none — direct SSH + psql.
- Exit: `pnpm verify:clip` returns success against a fresh
  test image; `SELECT classify_method, count(*) FROM
  fonto.assets GROUP BY 1` shows `clip` > 0; `clip_vec`
  coverage = 100% of image rows. Things-gate SELECT documented
  in `plan-ux-followups.md` under this phase block.
- Status: **DONE 2026-05-28**
  - verify:clip PASS — topLevel=photo, confidence=0.2114
  - clip_vec coverage: 24/24 active images (3 archived skipped)
  - classify_method: all historical rows remain llm-fallback
    (processed pre-fix); new uploads will get clip
  - CLASSIFY_RUNNER_UP_DELTA now overridable via env var
    (classify.ts change in same commit)

### Things-graduation gate SELECT

Copy-paste when ready to graduate Things tile from placeholder
to live class-grid (Phase 4.2). Returns a row when ≥6 distinct
classifications each have ≥10 active members:

```sql
SELECT count(*) AS qualifying_classes
FROM (
  SELECT classification, count(*) AS members
  FROM fonto.assets
  WHERE lifecycle_state = 'active'
    AND classification IS NOT NULL
  GROUP BY classification
  HAVING count(*) >= 10
) classes
HAVING count(*) >= 6;
```

Graduate when this returns count = 6 (or more).
Current state (2026-05-28): all 24 active images classified
as llm-fallback; run this query after the corpus grows.

## Phase 1.1 — Library chip-strip polish + back-button E2E

- Scope: wire `FilterPopover` + `FolderTree` (both existing) into
  the Library chip strip:
  - Date chip → opens a date-range popover (existing pattern).
  - Folder chip → opens a folder-tree popover that drives
    `directoryPath` + `directoryPathPrefix` on `useToolbarState`.
  - Classification chip → opens a popover w/ the active class list
    (ADR 0005 FU-C3 — popover, not flat strip, until corpus grows).
  - Back-button E2E — a playwright-style script that opens
    Library, applies each chip, opens the lightbox, presses back,
    asserts the grid position + chip state preserved.
- Deps: Phase 4.1's verification of CLIP populates the
  classification source-of-truth, so the chip can render real
  class options instead of stubs.
- Subagents: Explore subagent for back-button-preservation
  test-runner audit (does playwright config exist? is there an
  e2e/ dir?).
- Exit: all three chips wired + visible in the Library toolbar.
  Each round-trips through `useToolbarState`. Back-button E2E
  passes on all chip combinations.
- Status: pending

---

## Execution discipline (per skill Step 7)

This is a ≤3-session plan. Phase 1 (THIS SESSION) targets ~45%
context. Phase 2 + 3 are scheduled in next-session.txt handoffs.

Order chosen: **7b first** because it's the smallest and lowest
risk (one component, one fetch); landing it warms the deploy
chain and gives the operator something visible to confirm before
the data-ops in 4.1.

If runtime context exceeds ~45% during 7b, handoff before
starting 4.1 — do not partial-execute a data-ops phase mid-
session.
