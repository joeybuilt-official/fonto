# Roadmap — Fonto

> **SINGLE SOURCE OF TRUTH for this project's plans.** Every agent and contributor reads and edits
> *this* file. A new plan is a **row here** — never a new doc at the repo root, never a flat file in
> `docs/agents/`, never a top-level `<name>-plan/` directory. Detail belongs in
> `docs/agents/<area>/<feature>/plan.md`, linked from its row. Enforced by
> `scripts/check-plan-home.sh`.

Three views, three altitudes: **`roadmap.md`** (this file — initiatives and their band),
**`in-progress.md`** (the queue, with the exact next step), and the worklog (**`CHANGELOG.md`**
`[Unreleased]`). This file owns an initiative's existence, its band, and its links down.

## Now — in active development

| Initiative | Intent (one line) | Queue rows | Plan docs |
|---|---|---|---|
| The architecture gate | Every layer rule blocks, the backlog is a baseline that can only shrink, and coverage is asserted config-independently | rows 1–2 | `architecture/gate/plan.md` |

## Next — committed, not yet started

| Initiative | Intent | Depends on |
|---|---|---|
| Paying down the baseline | Fix the 172 route-handler violations in `app/api/`, then port the `lib/fusion` and `lib/evidence` database imports behind a port — 235 baselined violations is the honest backlog, not done | PR #15 merged (the baseline only exists there) |
| Fleet decoupling | Keep this repo free of sibling-project dependencies, imports, and `PLEXO_*` env reads | — `platform/fleet-decoupling/plan.md` |

## Later — directional, not yet committed

| Initiative | Intent |
|---|---|
| Asset intake at scale | Intake, classification, and storage as separate stages with independent scaling and backpressure |

## Shipped

| Initiative | Shipped |
|---|---|
| Panoply kit adoption | 2026-10-29 — `docs/agents` + `.agents/rules`, the doctor at `scripts/panoply.sh`, and every gate wired into `verify.yml` (`governance/kit-migration/plan.md`) |
