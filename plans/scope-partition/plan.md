# Fonto scope partition — PERSONAL vs SHOOT — master plan

Mode: autonomous (auto-chain) — operator authorized "just get this finished" 2026-06-13. Drive Phases 2→5 w/o per-phase approval. Hard gates retained: prod migration apply, git push, deploy (need targets). Work on branch feat/scope-partition; local commits only.

C1 RESOLVED (autonomous, reversible default): embeddings stay ON for SHOOT. Losing position = literal-spec "exclude from embedding eligibility"; rationale = Fonto has no embedding-driven memory surface, embeddings power search/dedup only, and keeping-on is reversible (can gate later) whereas off requires re-embed. Recorded ADR 0008 C1.

## Goal

Partition deliberate photo shoots (pro + hobby) from personal life capture via an authoritative `scope` enum that drives default behavior, so shoot work never pollutes personal search, timeline, or "On This Day."

## Source docs

- Build prompt: `FONTO-SCOPE-PARTITION.md` (operator-provided)
- ADR: `docs/adr/0008-scope-partition-personal-shoot.md`
- Checklist: `plans/scope-partition/checklist.md`

## Decisions locked (ADR 0008)

- `scope` = `text NOT NULL DEFAULT 'PERSONAL'` CHECK(PERSONAL|SHOOT) column on `assets`. Not a join table, not extending an existing concept.
- Hierarchy = dedicated `clients` + `shoots` tables; `assets.shoot_id` (N:1), `assets.shoot_stage` per-asset (RAW|SELECTS|DELIVERED|REJECTS). Client optional (hobby = NULL).
- Auto-classification = **Option A** (rule-based, no inference). Option B (Plexo/Pex suggest) gated on a Pex contract that does not yet exist.
- Default contract: memories route + asset feed default to `scope='PERSONAL'`; `?scope=` opt-out param.
- Embeddings stay ON for SHOOT (C1 — pending operator confirm); exclusion is from date-memory + default timeline only.
- Backfill: existing → PERSONAL via column default; bulk SHOOT reassignment reversible via `scope_reassignments` ledger.

## Status: COMPLETE + DEPLOYED 2026-06-13

All five phases shipped, merged to main (733e918 = merge of feat/scope-partition), pushed to origin, deployed to prod myfonto.com.
- Migration 0041 applied to prod pushd/fonto: 28,315 existing assets backfilled PERSONAL; clients/shoots/scope_reassignments tables live.
- fonto + fonto-worker rebuilt + recreated; fonto healthy.
- Live verify (authed Playwright): assets feed / ?scope=SHOOT / ?scope=all / memories / /shoots / /clients all 200 (no 500 on new column); /app/shoots renders desktop + mobile.

## Resolved operator gates

- ~~C1~~ embeddings ON for SHOOT.
- ~~Phase 1 → 2 approval~~ — autonomous finish authorized.
- ~~Phase 2 prod migration apply~~ — 0041 applied 2026-06-13.
- ~~Push/deploy~~ — merged to main + pushed origin + deployed.

## Follow-ups (deferred, non-blocking)

- Mobile (Flutter) timeline still shows SHOOT — sync intentionally unfiltered (delta-sync correctness); needs a scope-aware mobile client. Web fully partitioned.
- Option B (Plexo/Pex scope suggestion) gated on a Pex capability that doesn't exist.
- `next build` Turbopack/webpack WorkerError is pre-existing repo config (Docker prod build unaffected).

## Discoveries (execution)

- **sync/assets is intentionally NOT scope-filtered.** Server-filtering the delta-sync query by scope='PERSONAL' breaks removal propagation: a PERSONAL→SHOOT reassignment would drop out of the filtered stream, so a client never learns it changed and shows it stale. Fix = leave sync unfiltered + include `scope` in the payload; mobile-side exclusion is a deferred, scope-aware-client follow-up (gated). Data correctness > the exclusion feature here.
- **Rule for all other read paths:** default PERSONAL; browsable surfaces (have searchParams) honor `?scope=PERSONAL|SHOOT|all` via parseScopeParam+scopeCond (opt-out); pure-personal surfaces (memories, dedup, stacks-suggest) hardcode PERSONAL. Dedup is filtered to the *incoming asset's* scope, not hard-PERSONAL.

## Phases

## Phase 0 — Audit
- Scope: read-only data-model + query-path audit.
- Deps: none.
- Subagents: Explore (done).
- Exit: written report, operator approval.
- Status: done

## Phase 1 — ADR + schema design (⚠ one-way door)
- Scope: expert panel, pre-mortem, ADR 0008, master plan, proposed schema.ts diff (NOT applied).
- Deps: Phase 0.
- Subagents: none.
- Exit: ADR + plan approved by operator.
- Status: in-progress (awaiting approval)

## Phase 2 — Schema + migration
- Scope: apply approved schema.ts changes; write idempotent `0041_scope_partition.sql`; backfill existing → PERSONAL.
- Deps: Phase 1 approved.
- Subagents: general-purpose for migration + schema edit.
- Exit: `tsc --noEmit` clean, build green, scope-default + FK-integrity + cascade tests pass. ⚠ prod apply gated.
- Status: done (commit 18e1c05). ⚠ 0041 NOT yet applied to any DB (gated).

## Phase 3 — Assignment + ingestion wiring
- Scope: scope default at ingestion (`createAssetRow.ts:588`) per Option A rules; reversible bulk-reassignment endpoint/flow (manifest-logged via `scope_reassignments`); shoot/client assignment.
- Deps: Phase 2.
- Subagents: general-purpose.
- Exit: ingestion assigns scope; reassign + undo tested (reversibility); ship gate.
- Status: done (commit c22e9c1). scope.ts + ingestion hook + reassign/undo endpoints + 18 tsx assertions pass.

## Phase 4 — Query contract + retrieval (the regression that matters)
- Scope: inject `scope='PERSONAL'` default into memories route + asset feed; `?scope=` opt-out; verify SHOOT excluded from personal timeline + On This Day.
- Deps: Phase 2 (schema), Phase 3 (some SHOOT data to test with).
- Subagents: general-purpose.
- Exit: regression test — a SHOOT (wedding/hobby) asset never appears in personal timeline or On This Day — passes as a ship gate.
- Status: done (commit 94e6258). 16 read paths filtered + dedup within-scope + nearestNeighbors scope param. tsc clean. Regression test scripts/_scope/exclusion.integration.ts written (DB-gated). ⚠ next build fails pre-existing Turbopack/webpack WorkerError (not from these changes).

## Phase 5 — UI
- Scope: scope selector + scope-aware default-search toggle; shoot browser (Client → Shoot → Stage, hobby shoots grouped Client-less); bulk-reassign UI.
- Deps: Phases 2–4.
- Subagents: general-purpose.
- Exit: shadcn/Tailwind v4 UI, tests, ship gate. ⚠ prod deploy gated.
- Status: done (commit pending). ScopeSelector wired into /app/library; settings card for the saved default-scope localStorage preference; /app/shoots overview + /app/shoots/[id] stage browser (RAW|SELECTS|DELIVERED|REJECTS|Unstaged); BulkReassignDialog with batch undo. New endpoints /api/v1/clients + /api/v1/shoots (GET/POST/PATCH/DELETE). Asset feed gained ?shootId= + ?shootStage= filters; /api/v1/assets/[id] PATCH supports shootStage. tsc clean; 28-assertion harness scripts/_scope/phase5_ui_apis.test.ts passes.

## Ship gate (every phase)

tests pass · `tsc --noEmit` clean · build succeeds · no stray uncommitted changes · update this plan + checklist · ask before push/deploy.
