# Workflow: Change Approval & Planning

> **Applies when:** always — this is the baseline collaboration protocol for every project.
> **Delete this file (and its `@` import in CLAUDE.md) if:** never. If you disagree with a rule, edit it; do not delete the module.

## Change Approval

- **Describe your proposed changes and get approval before editing code.** State what you plan to change, which files, and why — then stop and wait for confirmation. Editing first and explaining after removes the user's only cheap moment to redirect you.
- **This applies to bug fixes exactly as much as to features.** "It's just a fix" is the most common excuse for skipping approval, and fixes are where wrong assumptions do the most damage.
- **Never assume the root cause. State your hypothesis and let the user confirm or redirect.** Say "I believe X is happening because Y — do you want me to fix it there?" rather than silently fixing what you guessed. The user usually knows something about the system you cannot see from the code, and a confident wrong diagnosis costs a full rewrite.
- **Name the layers the change touches** — Entities/Domain, Use Cases/Application, Interface Adapters, Frameworks & Drivers (see `clean-architecture.md`). A proposal written as a list of file paths hides the one thing worth catching early: which way the new dependencies point.
- **If the change would point a dependency outward, raise it before you write it, not after.** At proposal time it is a sentence and a redesign; once the code exists and works, nobody rewrites working code to fix an import direction, and the violation becomes permanent.
- When you find a second problem while fixing the first, surface it — do not fold it into the current change without asking. Scope creep smuggled into an approved change is unreviewable.

### What counts as trivial (no approval needed)

Proceed directly, and mention what you did afterward, when the change is:

- A typo, comment, or string fix with no behavioral effect.
- A one-line change the user explicitly described and asked you to make.
- Formatting, import ordering, or lint autofixes.
- Adding a log line or assertion to diagnose something, with no production behavior change.
- Any change fully contained in a file you were just asked to write.

Everything else — new files, new dependencies, schema/API/interface changes, anything touching more than one file, anything you would need a paragraph to explain — needs approval first. When in doubt, ask; asking costs one message, a wrong rewrite costs an hour.

This carve-out is itself a setting: a project that chose the **strict** protocol at adapt time deletes the list above, and every change — trivial or not — gets described and approved first.

## Planning Workflow

- **Enter plan mode before any non-trivial or multi-step work.** Any feature, milestone, or task spanning more than a couple of files starts with a plan — use the planning tool, not an informal chat summary, so the plan is an artifact rather than a paragraph that scrolls away.
- **ALWAYS persist the plan to a file under `docs/claude/`.** A plan that exists only in chat context dies at the next compaction, and you will silently resume with a different plan than the one that was approved. The file is the source of truth; the chat is not.
  - Copy `docs/claude/_templates/plan.md` as the starting point.
  - Write it into the relevant area folder, not flat in `docs/claude/` — e.g. `docs/claude/<area>/<feature>/plan.md`. See `docs/claude/_templates/feature-area/README.md` for the folder convention.
  - Link the new plan from `docs/claude/in-progress.md` in the same step, or nobody will find it.
- **When a milestone splits into sub-milestones, do not overwrite the parent plan.** Either nest the sub-milestones inline under their parent, or create a sibling file in the same folder and link to it from the parent. The parent plan must stay readable as a high-level overview — that overview is what a future session reads first to reorient, and flattening it into task-level detail destroys it.
- **Re-read the plan file at the start of each milestone.** Do this even if you "remember" the plan; after a compaction your memory of it is a summary of a summary.
- **Update the plan as work completes** — check off finished milestones, and record deviations inline with a `> **Build note:**` line explaining what you found and why the approach changed. Discoveries made during the build are the most valuable content in the file and the first thing lost if you do not write them down.
- If the work turns out to be materially different from the plan, stop and re-plan with the user rather than improvising forward. A plan that no longer matches reality is worse than no plan, because it still looks authoritative.

## Before you propose

The approval you are asking for is only as good as the proposal. Before you describe a change, run
the self-check in `quality-bar.md` — it governs *what* you propose; this file governs *when and how*
you propose it.
