# In Progress

**Read this first.** The ordered queue of what is next. Top of the list is what to pick up now.
Every item points at a plan doc — if an item has no plan doc, it is not ready to start.

The **Notes** cell of the active row is its handoff: keep the *exact next step* there — the file to
open, the command to run, the blocker — so the next session resumes cold.

## Active queue

| # | Item | Area | Initiative | Plan doc | Status | Notes |
|---|---|---|---|---|---|---|
| 1 | Merge the architecture gate (PR #15) | architecture | The architecture gate | `architecture/gate/plan.md` | In review | `chore/arch-gate-1a-blocking` at `34c13ea`, CI `verify` green, 235 baselined violations, self-test 10 cases. Dustin merges fonto PRs. Next: after merge, 1c = the 172 `app/api` route-handler violations, mechanically (declaration-order imports do not fix them; each needs its dependency reached through a port or a server-side helper). |
| 2 | Kit migration follow-through | governance | Panoply kit adoption | `governance/kit-migration/plan.md` | Done — archiving | Shipped on `chore/panoply-kit-migration`. Next: after it merges, delete the OLD trees `.claude/rules/` and `docs/claude/` — `migrate` leaves them in place by design, and keeping both means two homes for the same rule text. That removal is Dustin's call. |

## Blocked / waiting

| Item | Waiting on |
|---|---|
| The 235-violation backlog | PR #15 merging — the baseline file only exists on that branch |
| Deleting `.claude/rules/` and `docs/claude/` | Dustin's approval: the migration never removes a file it did not create, and the instruction here is never to delete |

**Status vocabulary:** `Not started` · `In progress — milestone N of M` · `Blocked — <on what>` ·
`In review` · `Done — archiving`.
