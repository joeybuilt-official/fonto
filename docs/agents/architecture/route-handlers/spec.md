# Route handlers stop owning queries (architecture gate, phase 1c)

Status: in progress — the `tags` slice has landed; the remaining 169 violations are sequenced in `plan.md`.

## User stories (prioritized)

1. **As a maintainer**, when a route handler changes, I can review transport concerns (authz, parsing,
   status codes, DTO shape) without reading SQL, because the query lives in the feature module that owns
   the data.
2. **As a second caller** (a worker job, a script, another route), I call the same operation the API calls
   instead of copying its query — and I inherit its invariants.
3. **As an on-call engineer**, when a tag move is refused, the refusal comes from one place with a stable
   code, not from whichever copy of the guard the route happened to keep.

### Independent tests

- Story 1: `app/api/v1/tags/route.ts` imports no `@/lib/db`, and `pnpm arch` reports the violation gone.
- Story 2: `lib/tags/store.ts` exports the operation; the route calls it.
- Story 3: `lib/tags/tree.test.ts` pins the invariants the store enforces.

## Requirements

- **FR-001** A route handler under `app/api/**` MUST NOT import `@/lib/db`, `@/lib/storage`, or `@/lib/queue`
  (rule `adapters-no-drivers`).
- **FR-002** A query a handler needs MUST live in the feature module that owns the table — `lib/<feature>/`
  — not in a new pass-through facade that re-exports the driver.
- **FR-003** A rule the query depends on (depth caps, cycles, ownership) MUST be enforced in that module and
  surface as a typed error the handler maps to a status code; the handler MUST NOT re-implement it.
- **FR-004** The baseline MUST shrink by exactly the number of violations the same PR fixes, and MUST NOT grow.
- **FR-005** The wire contract MUST NOT change: same fields, same status codes, same error messages.

## Domain & outside experts

Fonto's domain is media asset management for photographers and small studios. No new user-facing behavior
ships with this change, so no domain interview changes a decision here; the sequencing interviews are
recorded in `plan.md`. The "expert" input that matters is the API surface itself: 132 handlers written by
one team with the same nine imports.

## Success criteria

- The three `tags` routes import only transport modules and the feature module.
- `pnpm arch` exits 0 with the baseline three entries smaller.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm conformance` unchanged and green.
- Every later area follows the same recipe; no area invents its own pattern.

## Open questions

None. Scope questions that remain (which area next) are sequencing, not ambiguity, and live in `plan.md`.
