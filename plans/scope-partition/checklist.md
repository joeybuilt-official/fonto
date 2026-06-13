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
- [ ] Apply scope/shoot_id/shoot_stage columns + clients/shoots/scope_reassignments tables to schema.ts
- [ ] Write idempotent 0041_scope_partition.sql (CHECKs, indexes, partial memories index)
- [ ] Backfill existing assets → PERSONAL (via default)
- [ ] Tests: scope defaulting, FK integrity, cascade
- [ ] tsc + build green; commit (ask before push)
- [ ] ⚠ Apply 0041 to prod pushd/fonto (operator-gated)

## Phase 3 — Assignment + ingestion wiring
- [ ] deriveScope(source,directoryPath,cameraMake/Model,lensModel) in lib/scope.ts; hook before .values() ~createAssetRow.ts:587
- [ ] TUS direct insert lib/tus/server.ts:235 — relies on DB default PERSONAL (ok); optionally call deriveScope too
- [ ] Bulk reassignment endpoint (select by dir/source/batch/camera) — mirror lib/audit.ts recordAuditEvent + lib/stacks/operations.ts batch update
- [ ] scope_reassignments ledger + reversible undo; UNIQUE(asset_id,batch_id); only record when scope changes
- [ ] MUST bump seq via nextSeq (scope exposed in sync) — pattern app/api/v1/assets/[id]/route.ts:192
- [ ] Tests incl. reversibility; ship gate

## Phase 4 — Query contract + retrieval
Shared helper lib/scope.ts: parseScopeParam(searchParams)→'PERSONAL'|'SHOOT'|'all' (default PERSONAL); scopeCond(scope) drizzle condition. Browsable surfaces honor ?scope; pure-personal surfaces hardcode PERSONAL.
PERSONAL read-paths to inject (expert leak audit):
- [ ] app/api/v1/assets/route.ts:69 (feed — ?scope opt-out)
- [ ] app/api/v1/assets/buckets/route.ts:35 (scrubber — ?scope opt-out)
- [ ] app/api/v1/memories/route.ts:148 (On This Day — hard PERSONAL)
- [ ] app/api/v1/search/route.ts:36 (text search — ?scope opt-out)
- [ ] app/api/v1/search/clip/route.ts:140 (CLIP — ?scope opt-out)
- [ ] app/api/v1/stats/route.ts:79 (dashboard stats)
- [ ] app/api/v1/assets/places/route.ts:48
- [ ] app/api/v1/assets/within-bbox/route.ts:115
- [ ] app/api/v1/smart-collections/[id]/assets/route.ts:140
- [ ] app/api/v1/collections/[id]/assets/route.ts:35
- [ ] app/api/v1/sync/assets/route.ts:56 (mobile delta — hard PERSONAL)
- [ ] app/api/v1/workspace/shared-with-me/route.ts:48 (source asset join)
- [ ] app/api/v1/assets/[id]/similar/route.ts:36
- [ ] app/api/v1/workspace/reprocess/route.ts:43
- [ ] app/api/v1/collections/stats/route.ts:31,35,39,43,47 (5 counts)
- [ ] lib/stacks/suggest.ts:132 (+ stacks/suggestions inherits)
- [ ] lib/vectors/nearest.ts:72 — ADD scope param to nearestNeighbors (kNN hub; callers pass PERSONAL)
- [ ] lib/assets/createAssetRow.ts:216 findPHashNearDuplicate (dedup hard PERSONAL)
- [ ] lib/assets/createAssetRow.ts:349 findClipNearDuplicate (dedup hard PERSONAL)
- [ ] Regression test: SHOOT never in personal timeline / On This Day / search / stats (ship gate)
- [ ] Embeddings stay ON for SHOOT (C1) — no change to embed enqueue

## Phase 5 — UI
- [ ] Scope selector + default-search toggle
- [ ] Shoot browser (Client → Shoot → Stage; hobby grouped)
- [ ] Bulk-reassign UI
- [ ] Tests; ship gate; ⚠ prod deploy gated
