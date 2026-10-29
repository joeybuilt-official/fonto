# Spec before Plan

> **Applies when:** any **structural** change — a new feature, a new requirement, a change to observable
> behavior, or anything whose wrong shape would be expensive to undo. Runs after the Algorithm pass
> (`.agents/rules/algorithm.md`) and before `plan.md` is written.
> **Delete this file (and its `@` import in the generated agent hub) if:** never. If the project keeps
> requirements somewhere else, retarget this module at that place rather than dropping the rung.

## Why this rung exists

The kit has a strong **plan** rung and had no **spec** rung. A plan answers *how*: layers, ports,
milestones, dependencies. Nothing in the chain asked *what a user can do after this ships* and *how we
will know it worked*, in a form anything checks. So requirements survived only as prose inside a plan's
`## Goal`, where they are neither prioritized, nor testable, nor enumerable — and an ambiguity lived
comfortably all the way into implementation, where it silently became a guess nobody reviewed.

A spec is small on purpose. It is the cheapest possible place to discover that a requirement is
undefined, and the only place where "we have not decided this yet" is legal.

## The spec and the plan must agree — the coverage rivet

The spec rung and the plan rung are each sound and each **blind to the other**. Nothing has ever checked
that a plan covers what its spec requires, so a plan can look thorough, pass every gate, and quietly omit
a third of the requirements. That failure is silent by construction, which is why it survives.

So a plan with a sibling `spec.md` carries a **`## Spec coverage`** table: every `FR-NNN` in the spec
against the milestone that serves it. `scripts/check-coverage.sh` enforces both directions — a
requirement claimed by no milestone fails, and a plan citing a requirement the spec never declared also
fails. The second half is what makes the pair *agree* rather than merely look complete.

A requirement with no milestone is a decision, not an oversight: either write the milestone, or **delete
the requirement from the spec**. Deleting it is usually right — the artifact should state what is
actually being built, and an uncovered requirement is a promise the plan has already declined to keep.
If a requirement is deliberately deferred, say so in the row (`FR-014 | deferred`,
`FR-015 | not served — superseded by FR-020`) rather than leaving the cell empty.

**What the gate cannot see:** whether the named milestone genuinely delivers the requirement, whether the
milestone is any good, or whether the requirement is worth its cost. It closes *"was it mentioned at
all"* — the *"is it true"* half is a review question and gets asked there. A green run is not evidence
the plan is good.

Escape hatch: `COVERAGE_OFF=1`, for a deliberate exception. Say so out loud when you use it.

## Where a spec lives

`docs/agents/<area>/<feature>/spec.md` — a **sibling of the plan it belongs to**, in the same folder.

Not a `specs/` tree, and not a second plan home: `check-plan-home.sh` permits exactly
`docs/agents/<area>/<feature>/plan.md`, and both it and `check-algorithm.sh` glob `docs/agents/*/*/`.
A spec beside its plan needs no new allowance in either, and cannot become a competing plan doc.
Copy the shape from `docs/agents/_templates/spec.md`.

One feature has one spec and one plan, in one folder, linked from one `roadmap.md` row.

**Wiring is exempt.** CI workflows (`.github/`), the pre-commit hook, tsconfig/eslint/vite/jest config,
docker-compose, and `.agents/` are treated as **non-structural** by the gate: a change that alters
*when a gate runs* is not a change to what a user can do, so it needs no spec — the same reason a typo
fix does not. The exemption lives in `check-spec.sh`'s `CONFIG_RE` so it is auditable rather than buried
in the code rule.

**The lightweight plan home has no spec sibling.** A project too small for the `docs/agents/` spine may
keep one `docs/PLAN.md` (`workflow.md` → Planning Workflow), and `check-algorithm.sh` /
`check-expert-review.sh` accept it — but `check-spec.sh` searches only `docs/agents/*/*/spec.md`, so a
`docs/PLAN.md` repo has no path the spec gate recognises. If such a repo adopts this rung, either grow
the spine or set `SPEC_GLOB` to the sibling it does keep.

## What a spec owes

1. **User stories, prioritized (P1, P2, …), each independently testable.** Implementing P1 alone must
   leave a viable increment. If a story can only be tested once the others exist, it is not a story —
   split it, or state the one check that proves it alone.
2. **Acceptance scenarios per story, in Given / When / Then form.** These are what a test is later
   written from, so they must be concrete enough to be one.
3. **Numbered functional requirements**, each `MUST`-phrased and testable, stating behavior and never
   implementation.
4. **Measurable success criteria**, technology-agnostic. A number, not an adjective.
5. **Assumptions**, named explicitly, so a reviewer can challenge a default nobody stated.
6. **Domain & outside experts** — the industry or domain the software is built FOR, and who outside
   software was consulted (the filmmaker for a film-production tool, the restaurateur for a restaurant
   tool) plus what they said. Software-role input is not this: the kit already required architecture,
   security and review; the mistakes a domain practitioner catches in one sentence are the ones no
   framework knowledge sees. A project with no user-facing surface writes `n/a — no user-facing surface`;
   a change with no genuinely-relevant outside expert says so **and why**, in the argued-empty form the
   Algorithm pass already requires of a deletion list. **Placeholders until a real person was
   consulted — never a fabricated quote or an invented name.**
7. **User interviews (4 personas, simulated).** The spec names this project's OWN user personas, and
   planning **simulates an interview with four of them** before any UI/UX or functionality decision is
   made. Domain roles, not software roles: for a film-production tool a producer, a gaffer, an edit
   assistant, a post supervisor. Each interview is recorded with what it surfaced and **which design,
   screen, flow, field or rule it changed** — the interviews are the INPUT to design, not a summary
   written after it. An interface decision with no interview behind it is an unreviewed guess, exactly
   as a structural change with no spec is. **The artefact states plainly that the interviews are
   SIMULATED role-plays**: they surface requirements and failure modes a software-only view misses,
   and they are never written as a real quote from a real person. A genuinely-interviewed real user
   supersedes the simulation for that persona, and is named. A project with no user-facing surface
   writes `n/a — no user-facing surface` and says why; everything else gets four. **The `n/a` form is
   not only for libraries:** a change to internal tooling, CI, a script, or documentation has no screen
   to design, and says `n/a` with the reason. The test is whether the change alters what a *user of the
   product* can do — if it only alters how maintainers work, there are no product personas to interview.

## The marker rule — the one hard part

A requirement whose answer is unknown is written with a marker, never with an invented answer:

    - **FR-005**: The system MUST retain records for [NEEDS CLARIFICATION: how long, and who decides?]

`[NEEDS CLARIFICATION: <question>]` is **legal anywhere in a draft spec and nowhere else**. It is a
debt with two legal settlements: **answer it**, or **delete the requirement**. Never resolve one by
choosing a plausible value — that is the fabrication this kit forbids everywhere else, wearing a
spec-shaped costume.

**An unresolved marker must not survive into a plan.** The plan is where implementation begins, and an
ambiguity that reaches it has already become a guess. This is what `scripts/check-spec.sh` enforces,
which is why it is a gate rather than advice: an advisory "please clarify first" is exactly the rule
that drifts, and the whole reason this kit exists is that unchecked rules drift.

## The pass, in order

1. **Algorithm first** (`.agents/rules/algorithm.md`). Question each requirement and name its
   requester; delete what can be deleted; the spec then describes the *surviving* requirement. Writing a
   spec for something step 2 would have deleted is wasted ceremony.
2. **Write the spec** from `docs/agents/_templates/spec.md`. Stories and acceptance scenarios first —
   they expose gaps that a requirements list hides.
3. **Resolve every marker.** Answer it, or delete the requirement. Ask the owner when the answer is
   genuinely theirs (see `.agents/rules/quality-bar.md` → two options plus a recommendation).
4. **Name the domain and the outside experts** (item 6 above) — before the plan, because their input
   changes which stories and requirements survive, and a practitioner consulted after the plan exists
   is consulted about a decision already made.
5. **Interview four user personas** (item 7 above), simulated, and record what each changed. This sits
   between the spec and the plan because UI/UX and functionality decisions are the ones the interviews
   must feed — and a design decided before the interviews is a design the interviews cannot correct.
6. **Then the plan.** `plan.md` in the same folder, linked from the roadmap row, with its `Spec:` field
   pointing at this file — in the same change.

## What counts as routine (no spec needed)

Proceed directly, and say what you did, when the change is:

- A typo, comment, or string fix with no behavioral effect.
- A one-line change the owner explicitly described and asked for.
- Formatting, import ordering, or lint autofixes.
- A bug fix inside an existing pattern, where the acceptance criterion is the existing behavior.
- A refactor that changes no observable behavior — the existing tests already state the contract.

Everything else is structural. A change that alters what a caller can observe needs a stated criterion
for the new behavior, and the cheap moment to write it is before the code exists. **When in doubt, treat
it as structural** — the ceremony is one small file, and a wrong shape that reaches code is far more
expensive than a spec written in five minutes.

## Honest limits — read before trusting a green gate

`scripts/check-spec.sh` checks **presence and resolution**, and nothing more. It can tell that a spec
exists for a structural change and that no `[NEEDS CLARIFICATION: …]` survives in it. It **cannot** tell
whether:

- the stories are genuinely independently testable,
- the acceptance scenarios are concrete enough to be tests,
- the success criteria are measurable, or
- **whether the named domain expert is real, or whether anyone was actually consulted** — a section-presence
  check would pass on a fabricated expert and block no real mistake, which is exactly why no gate checks
  it,
- the requirements are worth what they cost.

Those stay review questions and belong in the plan doc's review — the `check-expert-review.sh` gate and
an independent SME read (a domain practitioner where the feature is domain-facing; the skill's
`adversary-review` rubric is the general form). **A gate that passes while a requirement went unexamined
— or while the industry was never asked — is a gate measuring the wrong thing**, and this one says so in
its own source, the same way `check-algorithm.sh` does.

## Enforcement — the honest version

Consistent with the kit everywhere else: prose is a suggestion, and the binding plane is required CI.

- **The rule is here.** This module is inlined into every tool-native mirror by `sync-agents.sh`, so
  every agent in every tool reads it.
- **The gate is `scripts/check-spec.sh`**, wired into `scripts/templates/ci-verify.yml` for the PR
  context and `scripts/templates/pre-commit` for the local one. It fires on a structural change with no
  spec, and on a spec carrying an unresolved marker, and it refuses in a message that names the remedy.
- **A gate must observe its own remedy.** The spec IS the remedy, so the gate exempts `docs/**` and
  `*.md` and can never block the write that satisfies it; the canary
  (`scripts/check-spec.test.sh`) asserts the refuse → apply the remedy → allow round trip closes.
- **`SPEC_OFF=1`** is the stated escape hatch for a deliberate exception. Say plainly that you used it,
  so the choice is reviewed rather than assumed. **`SPEC_INTERVIEWS_OFF=1`** is the narrower exception
  for the interview-section check alone, when the section is deliberately not required.
- **The honest floor:** a client-side hook is convenience, never enforcement — any agent can bypass it
  with `git commit --no-verify`. Only a required CI status check actually holds.
