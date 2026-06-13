# Fonto scope partition — checklist

## Phase 0 — Audit
- [x] Locate repo, branch, migration head (0040, no drift)
- [x] Audit asset table, partition concepts, query paths, ingestion, Pex boundary
- [x] Report + operator approval

## Phase 1 — ADR + schema design (⚠ one-way door)
- [x] Expert panel + surfaced conflicts (C1–C4)
- [x] Pre-mortem (3 causes + fallbacks)
- [x] ADR 0008 written
- [x] Master plan + checklist written
- [x] Proposed schema.ts diff (not applied)
- [ ] Operator approves ADR (incl. C1 embeddings deviation) — CURRENT GATE

## Phase 2 — Schema + migration
- [x] Apply scope/shoot_id/shoot_stage columns + clients/shoots/scope_reassignments tables to schema.ts
- [x] Write idempotent 0041_scope_partition.sql (CHECKs, indexes, partial memories index)
- [x] Backfill existing assets → PERSONAL (via default)
- [x] Tests: scope defaulting, FK integrity, cascade
- [x] tsc + build green; commit (ask before push)
- [ ] ⚠ Apply 0041 to prod pushd/fonto (operator-gated)

## Phase 3 — Assignment + ingestion wiring
- [x] deriveScope(source,directoryPath,cameraMake/Model,lensModel) in lib/scope.ts; hook before .values() ~createAssetRow.ts:587
- [x] TUS direct insert lib/tus/server.ts:235 — relies on DB default PERSONAL (ok); optionally call deriveScope too
- [x] Bulk reassignment endpoint (select by dir/source/batch/camera) — mirror lib/audit.ts recordAuditEvent + lib/stacks/operations.ts batch update
- [x] scope_reassignments ledger + reversible undo; UNIQUE(asset_id,batch_id); only record when scope changes
- [x] MUST bump seq via nextSeq (scope exposed in sync) — pattern app/api/v1/assets/[id]/route.ts:192
- [x] Tests incl. reversibility; ship gate

## Phase 4 — Query contract + retrieval
Shared helper lib/scope.ts: parseScopeParam(searchParams)→'PERSONAL'|'SHOOT'|'all' (default PERSONAL); scopeCond(scope) drizzle condition. Browsable surfaces honor ?scope; pure-personal surfaces hardcode PERSONAL.
PERSONAL read-paths to inject (expert leak audit):
- [x] app/api/v1/assets/route.ts:69 (feed — ?scope opt-out)
- [x] app/api/v1/assets/buckets/route.ts:35 (scrubber — ?scope opt-out)
- [x] app/api/v1/memories/route.ts:148 (On This Day — hard PERSONAL)
- [x] app/api/v1/search/route.ts:36 (text search — ?scope opt-out)
- [x] app/api/v1/search/clip/route.ts:140 (CLIP — ?scope opt-out)
- [x] app/api/v1/stats/route.ts:79 (dashboard stats)
- [x] app/api/v1/assets/places/route.ts:48
- [x] app/api/v1/assets/within-bbox/route.ts:115
- [x] app/api/v1/smart-collections/[id]/assets/route.ts:140
- [x] app/api/v1/collections/[id]/assets/route.ts:35
- [x] app/api/v1/sync/assets/route.ts:56 (mobile delta — hard PERSONAL)
- [x] app/api/v1/workspace/shared-with-me/route.ts:48 (source asset join)
- [x] app/api/v1/assets/[id]/similar/route.ts:36
- [x] app/api/v1/workspace/reprocess/route.ts:43
- [x] app/api/v1/collections/stats/route.ts:31,35,39,43,47 (5 counts)
- [x] lib/stacks/suggest.ts:132 (+ stacks/suggestions inherits)
- [x] lib/vectors/nearest.ts:72 — ADD scope param to nearestNeighbors (kNN hub; callers pass PERSONAL)
- [x] lib/assets/createAssetRow.ts:216 findPHashNearDuplicate (dedup hard PERSONAL)
- [x] lib/assets/createAssetRow.ts:349 findClipNearDuplicate (dedup hard PERSONAL)
- [x] Regression test: SHOOT never in personal timeline / On This Day / search / stats (ship gate)
- [x] Embeddings stay ON for SHOOT (C1) — no change to embed enqueue

## Phase 5 — UI
- [x] Scope selector chip strip (`app/(app)/app/shoots/_components/scope-selector.tsx`); wired into `/app/library`
- [x] Saved default-scope helper + hook (`lib/hooks/use-saved-scope-default.ts`); settings card under Account
- [x] Shoot browser overview `/app/shoots` (Client → Shoot rows w/ stage counts; hobby = client-less group)
- [x] Shoot detail `/app/shoots/[id]` with stage tabs (RAW|SELECTS|DELIVERED|REJECTS|Unstaged) + bulk-stage on selection
- [x] Bulk-reassign dialog (`bulk-reassign-dialog.tsx`) wraps POST /api/v1/scope/reassign + /undo; surfaces returned batchId for undo
- [x] Read APIs: `app/api/v1/clients/route.ts` + `app/api/v1/shoots/route.ts` (GET/POST/PATCH/DELETE, soft-FK semantics, per-shoot stage counts)
- [x] Asset feed gained `?shootId=` + `?shootStage=` (incl. `null`/`unstaged` sentinels) for the shoot browser
- [x] `/api/v1/assets/[id]` PATCH learns `shootStage` (RAW|SELECTS|DELIVERED|REJECTS|null)
- [x] Sidebar Shoots entry added
- [x] tsc --noEmit clean; tsx assertions `scripts/_scope/phase5_ui_apis.test.ts` (28 ok)
- [ ] ⚠ Apply 0041 to prod pushd/fonto (operator-gated)
- [ ] ⚠ Push feat/scope-partition + deploy (operator-gated)
