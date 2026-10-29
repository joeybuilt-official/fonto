# Wireframe before backend

> **Applies when:** a change has a user-facing surface — it alters what a user can do on a screen they
> look at. If it does not, record `n/a — <reason>` and skip this rung.
> **Delete this file (and its `@` import in the generated agent hub) if:** never. The rung is the only
> place design is decided before code makes the decision expensive.

## Why this rung exists

Backend decisions are cheap to change and frontend decisions are not. A data model reshaped on Tuesday
costs an afternoon; a screen's shape discovered to be wrong after it is built costs a week, because by
then the API, the state, the empty states and the tests have all been fitted to it. So the screen is
decided first, on paper, where a change costs one line.

And the screen cannot be judged by the person who drew it. An agent writing a wireframe and then
declaring it good has marked its own homework — the failure this rung is built to prevent. So every
wireframe is **interviewed against** before any backend work starts.

## The sequence — fixed

Expert input → persona interviews → **wireframe** → interviews against the wireframe → backend.

The two interview steps are different and both are required:

- **Before the wireframe:** what do these users actually do today, and what do they need? This shapes
  the screen. Without it, the wireframe is decoration.
- **Against the wireframe:** here is the screen — what is wrong with it? This is the step that changes
  decisions, and the only one that can catch a screen that is plausible but wrong.

## What a wireframe is, and where it lives

**A framework-free, in-tree artifact at a fixed path, reviewable as a diff.** Not a hosted tool, not a
screenshot, not a code component.

```
docs/agents/<area>/<slug>/
├── spec.md
├── interviews.md          # both interview rounds, one file
└── wireframe/
    └── index.html         # the screen, self-contained
```

Rules for the artifact itself:

- **One `index.html`, self-contained.** No CDN, no build step, no import that can fail to resolve. It
  opens by double-clicking it, and it renders identically on the reviewer's machine and in CI.
- **Framework-free.** The point is that the screen's shape is reviewable, not that a component library
  was exercised. React here would mean the reviewer reads JSX to see a layout.
- **No real copy.** Grey placeholder bars, not Lorem Ipsum and not the product's real strings. A
  wireframe that reads as finished stops being a wireframe: the reviewer starts proofreading instead of
  judging structure.
- **No brand colour, no imagery, no motion.** Same reason.
- **Not wired.** Nothing is clickable and nothing is functional. Interactivity is a later rung's job;
  a wireframe with working state invites the reviewer to test behaviour instead of the design.
- **It carries its own annotations.** Purpose, the state shown, what is deliberately absent, and the
  interactions to design against — in the artifact, not in a chat message that scrolls away.

Why in-tree and not Figma: the kit's premise is that an agent can author the artifact headlessly and a
reviewer can read the change as a **diff**. A hosted tool breaks both — the API cannot create a design
(read-only for content), and a screenshot is not a diff. The comparison was run and the result is
recorded in the factory plan.

## The skip test — one sentence

> **Does this change alter what a user can do on a screen they look at?**

If yes → the rung applies. If no → record `n/a — <reason>` in the spec, and **the reason is required**.
An `n/a` with no reason is indistinguishable from skipping the rung by accident, which is exactly what
this line exists to prevent.

`n/a` is the right answer more often than it feels. A shell script, a database migration, a CI gate, a
refactor with no visible change — all `n/a`. Only the user-facing ones need a screen.

## The interviews — the protocol that keeps them honest

**The generator never judges.** An agent that produced the wireframe may not be the one that interviews
it. If only one agent is available in an unattended run, the interview is recorded as **self-reviewed** —
labelled as the weaker evidence it is — rather than being dressed up as independent.

**The refuter role is mandatory.** One interviewee is assigned to **find what is wrong** with the
screen, not to confirm it. A panel that only agrees produces a transcript that has measured nothing.
The refuter's job is to name at least one thing that should change; if it genuinely finds nothing, it
says which parts it tried to break and could not.

**Personas are domain roles, never software roles.** "Agency producer who schedules crews" — not
"frontend developer". A persona that shares the builder's expertise cannot see the builder's blind spot.

**A finding names the decision it changed.** This is the anti-theatre control: a transcript of plausible
reactions that changed nothing is not an interview, it is a performance. So each finding records:

| Fields | |
|---|---|
| **Persona** | the domain role, and whether it is simulated |
| **What surfaced** | the observation, in the persona's words |
| **Changed** | the screen / flow / field / rule it altered — or `nothing — <why it was raised anyway>` |

`nothing` is a legal and useful answer. A finding that changed nothing is **recorded**, not dropped:
silently discarding it hides that the interview produced nothing, and quietly keeping it as if it were
decisive is the same lie in the other direction.

**Labelled simulated, always.** Every simulated interview is marked `SIMULATED` where it is recorded. A
simulation is a hypothesis about a user, not testimony from one, and presenting it as the latter is
fabrication. A real interview **supersedes** the simulation and is recorded under the person's name.

**Four personas minimum**, drawn from the spec's users. Fewer than four and the panel is the builder
agreeing with itself in different hats.

## Where findings live

One `interviews.md` beside the spec, holding both rounds. Nothing here is a separate tree: the interview
record is a sibling of the artifacts it judged, so a reader sees the spec, the screen, and what the
screen's own users said about it without switching context.

## What this rung cannot do

- It cannot tell whether a wireframe is **good** — only that it exists, is self-contained, and was
  interviewed against. Quality is a review question.
- It cannot make an interview **real**. A simulated panel is a hypothesis, and the labelling rule is the
  only thing standing between a plausible transcript and a fabricated one.
- It cannot stop a fluent, empty interview. The "changed what" column makes that visible; it does not
  prevent it.
- It cannot stop the skip rule eroding under "it's just a fix". The `n/a` reason is a speed bump: it
  makes the skip a written claim someone can disagree with, which is the most a rule can do.

## The gate — presence only

`scripts/check-wireframe.sh` enforces the rung. It answers **one** question: for a change with a
user-facing surface, does the artifact exist? A spec that is about something a user looks at must have
`wireframe/index.html` and `interviews.md` beside it, or must record `n/a — <reason>`.

**What it cannot see — read before trusting a green run:** not whether the wireframe is any good, not
whether the layout suits the user, not whether the interviews were honest, not whether the personas were
the right ones, and not whether the screen serves the spec's stories. Those are review questions and are
asked in the expert-review gate. This gate measures presence only, and a gate that claimed to judge
design would be measuring the wrong thing while looking rigorous.

**A bare `n/a` is refused.** The reason is required, because an `n/a` without one cannot be told apart
from skipping the rung by accident — which is the whole failure this line exists to prevent.

**The spec's own declaration wins over vocabulary.** A spec that explicitly records a reasoned `n/a` is
never dragged into the rung by a keyword, so "internal CLI — no screen in this tool" is not read as
requiring a screen. Vocabulary is the fallback, never the decider.

## Escape hatch

`WIREFRAME_OFF=1` for a deliberate exception, and the exception gets said out loud. A repo-wide off
switch exists because a genuine emergency is real; using it silently is not.
