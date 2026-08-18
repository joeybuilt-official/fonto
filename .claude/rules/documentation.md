# Documentation & Memory

> **Applies when:** always — this defines where project knowledge lives and how it survives context compaction.
> **Delete this file (and its `@` import in CLAUDE.md) if:** never. If the project keeps its knowledge base elsewhere, retarget the paths rather than dropping the module.

## Two tiers of memory

- **`docs/claude/` — team-shared, committed to git.** Facts about the project that any contributor or agent needs: what is being built now, what shipped, why the architecture is the way it is, and the patterns and gotchas that cost someone a day to learn. If a teammate would benefit, it goes here.
- **`~/.claude/` — personal, never committed.** Individual preferences, machine-local setup, per-user workflow habits. Keep it out of `docs/claude/`, because personal preference presented as project doctrine misleads everyone else on the team.

The distinction is not about secrecy, it is about durability: committed docs are versioned alongside the code they describe, so they can be reviewed, corrected, and blamed.

## Read order (start here, in this order)

1. **`docs/claude/in-progress.md`** — the ordered queue of what is next, with pointers to plan docs. Always read this first; it tells you what the current work actually is, which is the one thing a fresh context window cannot infer from the code.
2. **`docs/claude/architecture.md`** — the decisions and their reasoning, so you extend the design instead of re-litigating it.
3. **`docs/claude/key-patterns.md`** — conventions, gotchas, and testing practice, so your code matches what is already there.
4. **`docs/claude/infrastructure.md`** — deploy pipeline, hosting, data stores, secrets, background jobs. Read before touching anything that runs outside the dev machine.
5. **`docs/claude/completed-features.md`** — what already exists, so you do not rebuild it.
6. **The relevant area folder** (e.g. `docs/claude/<area>/…`) — active plans and research for the feature you are working on.

Read the specific files that bear on the task, not all of them every time. But never start non-trivial work without at least `in-progress.md` and the area folder for the thing you are changing.

## When to write

- **When a plan is made** — persist it to a file under the area folder, from `docs/claude/_templates/plan.md`, and link it from `in-progress.md`. Plans that live only in chat are erased by compaction.
- **During the build, at the moment of discovery** — when reality contradicts the plan, record it inline with a `> **Build note:**` line. Written later, it is written wrong; written never, the next person rediscovers it the expensive way.
- **When a decision is made that a future reader would otherwise question** — add an ADR entry to `architecture.md`. The trigger is "someone will wonder why we did this," not "this was hard."
- **Always ADR-worthy: anything that moves a layer boundary or introduces a port.** A new port and the adapter behind it, a rule relocated between layers, a Detail swapped out (database, framework, vendor), or a deliberate decision to let one layer know about another. These are precisely what `architecture.md` exists for: the reasoning is invisible in the diff six months later, so without the entry the next person re-litigates a decision that was already made carefully. See `clean-architecture.md`.
- **When you get burned by a non-obvious behavior** — add it to `key-patterns.md` as a gotcha, with the symptom, not just the fix. The next person will arrive with the symptom.
- **When infrastructure changes** — update `infrastructure.md` in the same PR as the change. Infra docs that lag the infra are worse than none, because they are trusted.

Update the doc in the same PR as the code it describes. A "docs pass later" never happens.

## When to archive

After a feature is tested and signed off:

1. Move its entire folder — plan, research, references, everything — into that area's `completed/` subfolder.
2. **Rename the files to describe what shipped**, not generic `plan.md`. A folder of six files named `plan.md` is unsearchable.
3. Add an entry to `completed-features.md`: what shipped, when, and the archived path.
4. Remove the item from `in-progress.md`.
5. Update any closed issue or milestone descriptions that pointed at the old paths.

Archive, do not delete. The reasoning behind a shipped feature is the context for the next change to it.

## Hygiene

- One fact, one home. If something belongs in `architecture.md`, do not also paste it into a plan file — copies drift, and a reader cannot tell which copy is current.
- Correct stale docs on sight. Finding an out-of-date statement and leaving it there makes you the reason the next person trusts it.
- Keep entries short and dated. These files are read under context pressure; a wall of prose gets skimmed and misread.
