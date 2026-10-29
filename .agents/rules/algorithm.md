# The Algorithm: Question, Delete, Simplify, Accelerate, Automate

> **Applies when:** always — a five-step pass run **in order** on any requirement, part, process, or
> tool before it is built, optimized, or automated, and re-run on anything already running.
> **Delete this file (and its `@` import in the generated agent hub) if:** never. If a step is wrong for a project,
> say which step and why in the plan doc; do not delete the pass.

## Why the order is the rule

The five steps only work in sequence, and the sequence is what agents get wrong. Optimization before
deletion polishes a thing that should not exist; automation before deletion entrenches it and makes it
expensive to remove later. Every step exists to make the next one cheaper.

The most common error in engineering is **deleting too little** — not too much. Deletion is the only
step that leaves no artifact: the output of deleting is *absence*, so there is nothing to show at the
end and no one notices it was skipped. That is exactly why it has to be an explicit step with a written
candidate list, rather than a good intention.

| Step | The question | The written artifact this step owes |
|---|---|---|
| 1. Question | Who asked for this, and which constraint does it serve? | A **requester name** and the constraint, per requirement |
| 2. Delete | What here can be removed entirely — and what has already been turned down? | A **deletion candidate list** — items removed, items kept, items **rejected**, and the reason |
| 3. Simplify | What is the least that satisfies the requirement? | The simplified shape, and what it dropped |
| 4. Accelerate | What is the measured rate, and what is the bottleneck? | A **measured number** before and after — never an adjective |
| 5. Automate | Which step is automated, and were steps 1–4 run on it first? | The named step, plus proof steps 1–3 already ran |

**Steps run in order, and a later step never substitutes for an earlier one.** If you are at step 5 and
cannot produce the step 2 artifact, the work is not at step 5 — go back.

## Step 1 — Question every requirement

Make the requirement **come with a name**. A requirement is not real until you can say who asked for it
and which constraint it serves; without both, it is a preference that will be defended as a necessity.

- **Requirements from smart people are the most dangerous**, because they are the least likely to be
  questioned. Rank by authority is backwards here: the higher the rank of the requester, the more the
  requirement must be written down and checked, not less.
- **A requirement with no name is deleted, not implemented.** "Best practice", "we've always", "the
  framework expects it" — none of these are a requester. Inherited convention is evidence, never
  authority, and answering "why do we do it this way" is part of the work rather than friction around it.
- **Distinguish the requirement from the constraint it serves.** The constraint is usually real; the
  requirement is one of several shapes that could satisfy it. Question the shape, keep the constraint.
- **Published defaults are the exception that proves the rule:** when a step says "applies unless the
  owner says otherwise", that owner's standing instruction *is* the named requirement. Do not re-litigate
  a decision the owner already made — name it and move on.

## Step 2 — Delete, and delete more than you think

**Delete any part or process you can.** If you are not adding parts back a meaningful fraction of the
time, you are not deleting enough. The healthy target is deleting far more often than adding; a team
(or an agent) that never removes anything is accumulating cost it will never pay down.

- **Every plan owes a deletion candidate list, not just the parts it adds.** "Nothing can be deleted
  here" is a conclusion that must be argued, not a default — and it is the answer that is most often
  wrong.
- **A rejected candidate belongs in the same list as a deleted one** — deleting a part and turning down
  a proposal are one act, "we considered this and are not doing it", and both leave the same absence.
  Give every rejection three things: what it was, why it lost, and **what we are doing instead** (the
  decision, requirement, or part that replaced it). A rejection with no *instead* is unfinished, and a
  rejection with no reason gets re-proposed next month by someone who never saw it — a conversation is
  not an artifact. One line per rejection, in the plan doc's list, written when the decision is made.
- **Record the rejection at the moment it happens, in the artifact that already exists.** A plan doc's
  candidate list is read by exactly the agent about to propose the same thing again, so it is the ledger
  — never a second decisions store, and never a chat thread. The whole point is that the answer is where
  the question gets asked.
- **Nothing is protected by virtue of working.** "It works, so leave it" is how dead weight survives.
  Working is the floor, not the justification for existing. The test is demand and artifact, not function.
- **Delete the step before deleting its implementation.** A process that produces nothing anyone reads
  is the cheapest thing on the list; removing it costs one line and saves every future cycle.
- **Prefer deleting a whole thing to optimizing it.** Removing a part is free; making a part fast is
  not, and the fast version still has to be maintained forever.
- **Never delete safety backstops while deleting weight.** Gate canaries, secret scans, and approval
  boundaries are the exception: they exist to fail loudly, they are cheap when nothing is wrong, and
  the correct deletion candidate is a *step that duplicates them*, never a backstop itself.
- **When you delete, ship the absence deliberately** — say in the plan and the worklog what was removed
  and what callers must do instead, since absence leaves no artifact to read later.

## Step 3 — Simplify only after you have deleted

Simplification is where effort feels most productive and is most often wasted, because it is the step
people reach first. **Do not simplify or optimize a part that should not exist.**

- The least shape that satisfies the named requirement wins; everything beyond it must justify itself
  against the requirement from step 1, not against symmetry, convention, or a future that has not been
  requested.
- Simplifying is a change to *how*; the requirement, its inputs, and its outputs do not move. If the
  boundary itself moves, that is a step 1 or step 2 finding — go back, do not absorb it here.
- A simplification that trades away correctness, security, or an enforced gate is not a simplification;
  it is a deletion of a backstop wearing a smaller diff.

## Step 4 — Accelerate cycle time, but not before steps 1–3

**Every process can be sped up — but never before the first three steps are done.** Speed applied to the
wrong step is the most expensive mistake available, because it makes the waste arrive faster.

- **State a measured number, or the claim is not made.** "It's faster now" is not a result. Name the
  metric, take a baseline before the change, and give the same metric after — in the same units, same
  conditions.
- **Find the bottleneck before removing it.** Speeding up a non-bottleneck produces no observable change
  and is indistinguishable from doing nothing.
- Where cycle time is genuinely the constraint, prefer structural fixes (fewer steps, one batch, one
  branch, fewer humans in the loop) over effort spent making an existing step marginally quicker.

## Step 5 — Automate last

**Automate only what survived steps 1–4.** Automating a step that should have been deleted multiplies
the waste, and the automation is what makes it expensive to remove later — the effort already spent
becomes the argument for keeping it.

- Name the step being automated, and show the artifacts for steps 1–3 on *that* step. A hook, a plugin,
  a watcher, or a scheduled job with no such artifacts is an automation of an unexamined process.
- **An automation with no artifact and no demonstrable demand is a deletion candidate**, not an asset —
  trigger counts and produced artifacts are what tell the two apart, so a recurring job must be able to
  show both.
- A gate is an automation, and it is subject to this rule: a gate that cannot observe its own remedy, or
  whose verdict is stale, is automating a process nobody finished designing. Prove the gate can be
  passed before enforcing it.

## The pass, applied to work at hand

Before proposing a non-trivial change, a new process, a new tool, or an automation, answer these in the
plan doc or the proposal — briefly, one line each, in order:

1. **Question** — who asked, and which constraint does it serve? _(no name → it does not get built)_
2. **Delete** — what can be removed instead? _(name the candidates — including "the whole request"; and
   add every approach already turned down, with what we do instead)_
3. **Simplify** — what is the least that satisfies the named requirement?
4. **Accelerate** — what is the measured rate today, and where is the bottleneck?
5. **Automate** — is this the last step, and were 1–3 actually done on it?

**Scope test — do not add ceremony to routine work.** A typo, a copy change, a bug fix inside an
existing pattern, a one-line change the owner asked for: skip the pass and say what you did. The pass
earns its cost when the thing under question is a requirement, a part, a process, or a tool — anything
whose existence, shape, or enforcement is being decided. If a wrong shape would be expensive to undo,
run the pass; if not, do not.

## Enforcement — the honest version

Consistent with the kit's rule everywhere else: prose is a suggestion, only what is wired is a mandate.
`scripts/check-algorithm.sh` is the mechanical floor for kit-governed repos — it checks what can be
checked without judgement:

- a **structural** change exists — a code-suffixed file (`.ts`, `.py`, `.sh`, `.yml`, …) or a path under
  `src|apps|packages|lib|scripts|e2e|infra|migrations/` — skip if not. Docs/rules-only edits are exempt;
- the plan doc for the area exists and carries a **Deletion candidates** section, so the step-2 artifact
  is present rather than assumed.

It runs in git mode (diff against `origin/<base>` or `HEAD~1`), `--since <sha>`, or `--staged`;
`ALGORITHM_FILES` overrides what counts as code and `ALGORITHM_PLAN_GLOB` where a plan lives. If the
diff base does not resolve (a depth-1 checkout, a wrong ref), the gate **refuses with exit 2** rather
than reporting a clean tree about a comparison that never happened — the same rule every gate here
obeys.

It cannot judge whether the deletion list is *good*, whether a rejection's *instead* names something
real, whether the requirement's requester is real, or whether the measured number is honest. Those stay a
review question — ask them explicitly in the expert-review gate rather than trusting the script's green
check. A gate that passes while a requirement went unexamined is a gate measuring the wrong thing.

Escape hatch: `ALGORITHM_OFF=1` for a deliberate exception. Say plainly that it was used, so the choice
is reviewed rather than assumed — an undocumented bypass is a rule nobody can audit.
