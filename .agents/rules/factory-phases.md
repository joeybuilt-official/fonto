# The factory phases

> **Applies when:** you are asked to work on a repo — any repo — and need to know where in the process
> it stands, or a repo is being brought into the factory.
> **Delete this file (and its `@` import in the generated agent hub) if:** never. Every other rung
> asks "which phase is this?" — without the phase model there is no answer.

## Why this exists

Work arrives at a repo at whatever stage it is actually in, not at the stage a process document assumes.
A repo may have code and no spec; a plan with every milestone ticked and nothing shipped; a stale kit
stamp claiming a version it is not. A process that starts every task at "write the spec" wastes effort
on repos that are already past it, and a process that starts at "build" skips the rungs whose absence is
why the work is stuck.

So the phases are named, and the phase a repo is in is **detected from evidence on disk** rather than
assumed or asked. `scripts/factory-detect.sh` reports it; `scripts/factory-phases.tsv` holds the order.

## The seven phases

| # | Phase | The thing that must exist | How it is proven |
|---|---|---|---|
| 0 | **Adopt / Audit** | the current kit (`panoply.sh doctor` exit 0) | `scripts/panoply.sh` |
| 1 | **Spec** | `spec.md` beside the feature, no unresolved marker | `scripts/check-spec.sh` |
| 2 | **Wireframe** | `wireframe/index.html` **and** `interviews.md` | `-` (M3/M4) |
| 3 | **Plan** | `plan.md` with a `Next step` and a coverage table | `scripts/check-plan-home.sh`, `scripts/check-coverage.sh` |
| 4 | **Build** | open milestones and a branch off the trunk | `-` |
| 5 | **Verify** | a fresh green verify on the branch | `-` |
| 6 | **Ship** | merged, folder in `completed/`, queue row closed | `scripts/check-launch.sh` |

A `-` in the gate column is a **stated gap**, not a licence. Phases 4 and 5 have no gate yet; that is
recorded rather than hidden, because "no gate" and "gate passed" must never look alike. Phase 6 is
gated by `scripts/check-launch.sh`: a change that marks a ship milestone complete must record, in the
feature folder, that the thing was launched **and** a rollback line (a sibling `launch.md`, or a
`## Launch` section in the plan). The gate checks the *record*, not the mechanism — it never guesses
the deploy path, because a stack-agnostic kit cannot know it.

## The rule the detector applies

**Scan the evidence from the END backward, and report the furthest phase whose completion is actually
evidenced.** Today's work is the newest thing in a repo, so evidence of a later phase outranks evidence
of an earlier one. A repo with a spec and no wireframe is at Phase 2, not Phase 1.

Precedence, exactly:

1. **Not a git working tree** → refuse. Not a phase — an inspection that did not happen reports as itself.
2. **Doctor exit ≠ 0** → **Phase 0**. Below this line the phase history is not trustworthy, so the kit
   is the first thing to fix. The doctor's **exit code is the authority, not the stamp's own claim** —
   a stale stamp is exactly the false-green the doctor's generation marker was built to kill.
3. **Doctor clean but no feature folder** → **Phase 0** — the spine is un-seeded; audit produces the baseline.
4. **An unresolved `[NEEDS CLARIFICATION]`** → **Phase 1**, blocked on the marker.
5. **No spec** → **Phase 1**. If the work already exists, **backfill** the spec and mark it backfilled —
   do not block a working repo on a retroactive spec (ceremony the scope test forbids), and do not
   proceed with no spec at all (the failure this rung exists to prevent). Draft-and-mark is the honest middle.
6. **Spec with a user-facing surface, no wireframe** → **Phase 2**.
7. **Wireframe present, no `interviews.md`** → **Phase 2**, blocked on interviews.
8. **No plan** → **Phase 3**.
9. **Open milestones** → **Phase 4**.
10. **Non-trunk branch or uncommitted work, no open milestone** → **Phase 5**.
11. **Milestones closed, tree clean, on the trunk** → **Phase 6**.

## Which feature is "the" feature

A repo holds many feature folders. The detector picks the one the queue (`docs/agents/in-progress.md`)
names as active; if the queue names none, the newest by mtime. It reports which one it chose, because
a phase reported against the wrong feature is worse than no answer.

## What the detector cannot see

Read this before trusting a result. The detector reports **the phase the files evidence**, not the phase
the work is in.

- A plan with every milestone ticked reads as Phase 6 whether or not anything shipped.
- A branch with commits but no locally discoverable CI signal reads as Phase 4 when it is really at 5.
- It cannot judge intent, quality, or whether an artifact is any good — only that it exists and what it
  says about itself.
- A repo on a stale kit **cannot** be read as anything but Phase 0. That is the honest answer, not a defect.

Every report names the observations that fired, so a wrong answer can be argued with by pointing at the
specific observation that was wrong. That is why it reports evidence rather than a verdict.

## Using it

```sh
sh scripts/factory-detect.sh                 # where am I? (the cwd's repo)
sh scripts/factory-detect.sh --path DIR      # another checkout
sh scripts/factory-detect.sh --json          # machine-readable, for a later rung
```

There is deliberately **no** fallback to the kit's own repo. `--kit-repo` opts into that. An inspection
target the caller never named must be their explicit choice: reporting a confident phase for a repo
nobody asked about is "could not look" dressed as a finding.

No model call decides the phase. Every observation is a file test or a grep, and the precedence is a
fixed order — so two people running it on the same tree get the same answer, and disagreeing with it
means pointing at an observation.

Escape hatch: `FACTORY_PHASE_OFF=1` where a caller wants to skip detection deliberately.
