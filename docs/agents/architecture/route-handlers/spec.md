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

## User interviews (simulated, 4 personas)

These are SIMULATED role-plays, not quotes from real people. Each line is anchored in an artifact in this
repo (the wire contract in `lib/openapi/routes.ts`, the mobile client's calls, the guard code), and each
names the decision it changed.

| # | Persona | What they were asked | What they said (SIMULATED) | Decision it changed |
|---|---|---|---|---|
| 1 | Photographer tagging her library in the web UI | "What must not change while the tags code is reorganized?" | "Don't move my tags, don't rename my folders, and don't make the tree slower to open." | FR-005 — the wire contract is frozen, including the 400 strings, so the refactor is invisible to the client |
| 2 | Mobile client (`mobile/`) calling `/api/v1/tags/top` | "What do you depend on?" | "One call, one shape: id, name, color, count, one sample asset. If you re-shape it I ship a client update for nothing." | `listTopTags` returns the same aggregate row type; the route still wraps it in `{ tags }` |
| 3 | On-call engineer reading a 400 from a tag move | "What would make this refactor make your night worse?" | "A move that half-applied. Or a new error string I can't grep because it changed." | The cycle/depth guards move **with** the transaction, and `TagRuleError` keeps the exact messages the handler used to send |
| 4 | Maintainer adding a worker job that touches tags | "What do you want from this change?" | "An operation I can call, not a query I have to copy — and the depth rules travelling with it." | FR-002/FR-003 — `lib/tags/store.ts` is the one home; a second caller inherits the invariants |

## Success criteria

- The three `tags` routes import only transport modules and the feature module.
- `pnpm arch` exits 0 with the baseline three entries smaller.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm conformance` unchanged and green.
- Every later area follows the same recipe; no area invents its own pattern.

## Open questions

None. Scope questions that remain (which area next) are sequencing, not ambiguity, and live in `plan.md`.
