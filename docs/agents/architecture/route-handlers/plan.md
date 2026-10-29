# Plan — route handlers stop owning queries (1c)

Status: slice 1 landed (`tags`); 169 of 172 violations remain and are sequenced below.

## What the measurement says

`adapters-no-drivers` counts **172 edges in 132 of 161 route files**, and the files behind them are
**18,113 lines with 1,547 lines of db / storage / queue work**. The assignment called these "mechanical".
They are mechanical in *shape* — nine imports, twenty distinct names — but not in *effort*: what moves is
inline drizzle query construction interleaved with business rules (depth caps, cycle guards, keyset
cursors, manifest hashing), not an import line. Two of the three `tags` handlers were 130 lines each and
roughly half of that was query logic.

## The recipe (one area per PR, ratchet in the same PR)

1. Create `lib/<feature>/store.ts` (or extend the feature module that already owns the table).
2. Move the query bodies there verbatim; move the rules beside them; return rows, not HTTP.
3. Throw a typed `RuleError` for a refusal; the handler maps `code`→status and keeps the message.
4. Rewrite the handler to: authz → parse → call → serialise. No `@/lib/db` import left.
5. `pnpm arch:baseline`, then `pnpm arch` — the baseline must shrink by exactly the fixed count.
6. Tests: pin the rules the store enforces; a handler test where the route had one.

## Slice log

| Slice | Area | Violations | State |
|---|---|---|---|
| 1 | `app/api/v1/tags/**` | 3 | **landed** — `lib/tags/store.ts`, `lib/tags/tree.test.ts` |
| 2 | `v1/folders/**` | 3 | next — `lib/folders/` already owns `normalize.ts` |
| 3 | `v1/stacks/**` | 5 | `lib/stacks/operations.ts` already owns the stack SQL |
| 4 | `v1/collections/**` | 5 | |
| 5 | `v1/persons/**` + `person-groups` | 9 | largest single domain cluster |
| 6 | `v1/workspace/**` + `v1/sync/**` | 10 | touches auth-adjacent paths; needs care |
| 7 | `v1/assets/**` | 24 | the core grid: keyset cursors, `serializeAsset`, bbox queries |
| 8 | `v1/integrations/**`, `v1/imports/**`, `v1/webhooks/**` | 16 | |
| 9 | `v1/uploads/**`, `v1/shares/**`, `v1/duplicates/**` | 10 | |
| 10 | `admin/**` (backfills + review queue) | 9 | the least test-covered surface |
| 11 | the remaining singletons | ~58 | mostly one-query routes; batch by area |

## Deletion candidates

| Candidate | Removed? | Why |
|---|---|---|
| A pass-through facade `lib/db-facade.ts` re-exporting `db`/`schema` so handlers stop importing the driver | **No** | It satisfies the letter of the rule with a shell; the query would still be in the handler. Explicitly refused. |
| A blanket `db` export on the feature module (`export { db } from "@/lib/db"`) | **No** | Same shell, one level deeper. |
| Relaxing `adapters-no-drivers` back to `warn` | **No** | A `warn` nobody can fail is the defect phase 1a removed. |
| The per-handler query copies inside `[id]` handlers (`tags` had three near-copies of `nextSeq` + update) | **Yes** | Collapsed into `store.ts`; the third call site is the one that could have drifted. |
| A separate `dto` layer for these three routes | **No** | `jsonSafe` + row passthrough is the existing contract; a DTO layer here would be new surface with no caller. |
| Renaming the `tags` handlers during this change | **No** | Out of scope; it would obscure the diff that the ratchet is reviewed against. |
| Any change to the tag wire format | **No** | FR-005 keeps this a pure move. |

## Risks

- **`lib/<feature>/` was unpoliced by the layer map — fixed in this PR.** The dependency-cruiser layers named
  `lib/processing/` as application and `lib/db|storage|queue` as drivers; the feature modules (`lib/tags`,
  `lib/assets`, …) were neither, so a query moved into `lib/` left the policed set instead of becoming
  application code in the map's own terms. `drivers-no-upward` now names the repository shape
  (`lib/[a-z0-9-]+/store\.ts$`) as a target and `.agents/rules/clean-architecture.md` maps it in the
  Interface Adapters row. Residual: the gate still cannot print *which* edges left the measured set when a
  baseline shrinks — that belongs to the kit batch, not to a slice.
- **No route-level tests exist for most of these handlers**, so the move is proved by typecheck + the gate +
  the existing suite, not by behaviour tests. Slice 1 adds the first `lib/tags/tree.test.ts`; later slices
  should add a handler test where the behaviour is not obvious.
- **Stacked on PR #16.** The baseline file conflicts with #15 by construction; regenerate after whichever
  lands second.

## Findings outside this change

1. 132 of 161 route handlers reach the driver directly — the largest gap in the four-layer map.
2. The feature-module layer (`lib/<feature>/`) was outside every rule, so a query moved there left the
   policed set rather than becoming application code in the map's own terms. **Named and policed in this
   PR.** What is still missing is the audit: the gate reports the new count, not the edges that left it.
