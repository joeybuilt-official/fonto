# Plan — architecture gate, phase 1a: every layer rule blocks

Status: implemented 2026-10-28, awaiting review. Predecessor: the gate itself (`92056fe`).

## What phase 1a is, and what it is not

The gate that landed on 2026-10-28 asserted its own coverage and encoded the four-layer map, but it
encoded **three of the ten rules as `warn`**. A `warn` severity is a rule nobody can fail: it printed
242 times per run for months and blocked nothing, which is the same shape as the defect the gate was
built to remove — an assurance that costs nothing to break.

1a fixes exactly that, and nothing else. It does **not** reduce the 242 violations, and it says so
plainly rather than implying progress: the number of coupling defects in this repo is unchanged by
this change. What changes is that a **243rd** one can no longer be added.

## The change

1. **Promote the three layer rules to `error`** in `.dependency-cruiser.cjs` — `domain-stays-pure`,
   `application-no-drivers`, `adapters-no-drivers`. All ten rules are now blocking.
2. **Record the existing backlog as a baseline**, `.dependency-cruiser-known-violations.json`:
   242 entries, generated from the tree *after* the promotion so each entry carries the severity the
   config now declares.
3. **Assert the two things a baseline can lie about**, on every run:
   - `(rule name, severity)` set equality — every distinct pair the baseline records must be declared
     in the config at exactly that severity, so a rename or a demotion without re-recording fails by
     name instead of grandfathering nothing;
   - no dead entries — every baselined `from`/`to` naming a repo path must still be a cruised module,
     so a deleted or renamed file's entry fails instead of inflating the "known" count forever.
4. **Ten self-test cases** (`pnpm arch:self-test`, six expected to fail) over that logic, plus five
   end-to-end probes run by hand on the real tree, quoted in the change description.
5. **Delete `HEALTHY_BASELINE`**, the typed `{ modules: 620, dependencies: 2566 }` pair printed as
   `baseline 620/2566`. It asserted nothing, it sat 25 words from `repo modules 544 (baseline 544)` —
   two different quantities both called "baseline" — and it was already stale against the 627/2580 the
   same run measured. The run line now prints the measured baseline length.

`couldNotResolve == 0` needed no work: the gate has failed on any unresolvable import since it landed
(the check is at the `unresolvable.length > 0` branch). 1a proves it fires rather than re-implementing it.

## Why a baseline and not a fix

Fixing 242 violations in one PR is not a change, it is a rewrite of the boundary between the route
layer and persistence across 132 files, and it would be reviewed as "trust me". The baseline is the
honest middle: the debt becomes a number that cannot grow, each rule blocks on contact for new code,
and the file shrinks as files are fixed. The alternative — leave them `warn` — is the state that made
the problem invisible for months.

## Deletion candidates

Every plan owes this list, because deletion is the step whose output is absence.

| candidate | verdict |
| --- | --- |
| `HEALTHY_BASELINE` (typed module/dependency pair) | **deleted** — asserted nothing, already stale, and duplicated the word "baseline" beside a real one. |
| the three `warn` severities | **deleted** — replaced by the baseline as the mechanism that separates old from new. |
| the whole 1a change | *not* deleted: the assignment's request stands, and the measured cost of the alternative is on record above. |
| `--write-baseline` as the documented exit from a red gate | **kept, but framed** — it is a reviewed act that rewrites both ratchets; the PR that regenerates it must show why. |
| a second check on `summary.ignore` counts | **not added** — the dead-entry check covers the same rot from a source that can name the file. |

## Probes (the evidence, not the intention)

Run on the real tree, each restored afterwards; the gate's exit code and the message it printed:

| probe | expected | measured |
| --- | --- | --- |
| new `lib/fusion/` → `@/lib/db` import | fail, naming `domain-stays-pure` | exit 1, `error domain-stays-pure: lib/fusion/__probe_canary.ts → lib/db/index.ts` |
| new `lib/processing/` → `@/lib/db` import | fail, naming `application-no-drivers` | exit 1, named |
| new `app/api/**/route.ts` → `@/lib/db` import | fail, naming `adapters-no-drivers` | exit 1, named |
| rule renamed in config, baseline untouched | fail, "not declared" | exit 46, `✖ 1 rule name(s) in the baseline are not declared` |
| baseline entry hand-edited to `warn` | fail, "changed severity" | exit 1, `✖ 1 rule(s) changed severity without the baseline being re-recorded` |
| baseline `from` pointed at a removed file | fail, dead entry | exit 1, `✖ 1 baselined violation(s) can no longer fire` |
| `@/lib/does-not-exist` import | fail, unresolved | exit 1, `✖ 1 import(s) did not resolve` |
| clean tree | pass | exit 0, `242 ignored`, `arch-gate: OK` |

## What remains (phase 1b, not this change)

- Shrink the baseline: 172 route-handler violations are the largest and the most mechanical, and each
  one removed lowers a number that cannot rise.
- The `domain-stays-pure` entries that are **`drizzle-orm` imports in `lib/fusion/`, `lib/evidence/`
  and `lib/classify/`** — that is a vendor ORM inside the domain layer, the single worst class in the
  set, and it needs a port rather than a re-record.
