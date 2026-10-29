# Plan: Panoply kit migration (old layout → docs/agents)

- **Status:** implemented 2026-10-29, awaiting review
- **Spec:** `spec.md` in this folder
- **Branch:** `chore/panoply-kit-migration` (stacked on `chore/arch-gate-1a-blocking`, PR #15)
- **Kit:** `unreleased` at `ad139e2`, source `/opt/data/panoply-kit`

## Goal

Move the repo onto the current kit layout so the doctor certifies it, the agent gate stops refusing
edits, and the landing gates run in CI.

## Context

Before: `.claude/rules/` held 14 adapted rule modules; `docs/claude/` held two feature folders and
nothing else; `scripts/` carried three kit scripts from an older generation (`check-docs.sh`,
`sync-agents.sh`, `check-expert-review.sh`) and no doctor at all. `AGENTS.md` was 119,605 bytes because
it inlined every rule body; `CLAUDE.md` carried the real project facts (stack, commands, structure) and
`@`-imported the modules.

## Architecture

Layers touched: **none** — this change moves documents and gate scripts. The one code-adjacent surface
is `verify.yml`, where the new steps run. Nothing under `lib/`, `app/`, or `mobile/` changed, which the
gate output confirms: module and dependency counts are identical to the base commit apart from the
`scripts/` delta.

## The Algorithm pass (question · delete · simplify · accelerate · automate)

1. **Question** — who asked for this? The Panoply kit's own gate, in the repo's own `AGENTS.md`
   ("adopting it IS the first batch of work"), reinforced by a blocked `write_file` on 2026-10-29. The
   constraint it serves: one home for the rules, and gates that a non-agent contributor cannot skip.
2. **Delete** — see the list below. The largest deletion is 119,605 → 22,460 bytes of `AGENTS.md` by
   removing the inlined rule bodies that already existed in `.agents/rules/`.
3. **Simplify** — the kit template is the base and fonto's project facts are inserted, rather than
   hand-writing a hub. The migration is one `migrate` + one `apply --force-scripts`, not a manual copy
   of 14 modules.
4. **Accelerate** — not applicable; no runtime path changed. The measurable claim here is the gate
   count in CI: 3 before (typecheck, lint, arch), 10 after, each a separate step so a failure names its
   own rule.
5. **Automate** — the mirror regeneration is automated (`sync-agents.sh`, `--check` in CI), and the
   baseline/gate checks run in CI rather than in a pre-commit hook, which `--no-verify` skips.

### Deletion candidates

| Candidate | Disposition | Why |
|---|---|---|
| The 119 KB inlined rule bodies in `AGENTS.md` | **deleted** | They duplicated `.agents/rules/*.md` verbatim; the kit's index replaces them |
| `.claude/rules/*.md` (14 modules) | **kept, flagged for the owner** | Superseded by `.agents/rules/*.md`, but the migration never deletes a file it did not create. Removing them is Dustin's call (`in-progress.md` row 2) |
| `docs/claude/` (2 folders) | **kept, folded forward** | Plans `git mv`-ed to `docs/agents/architecture/gate/` and `docs/agents/platform/fleet-decoupling/`; the now-empty tree stays until the owner removes it |
| The old `scripts/sync-agents.sh` (185 lines diverged) | **replaced, backup kept** | Its "self-contained: inline every body" behaviour is what produced the 184 KB `CLAUDE.md` that harnesses truncated; `.panoply-bak` sits beside it |
| The old `scripts/check-docs.sh` (34 lines diverged) | **replaced, backup kept** | Older generation; the current gate additionally checks the plan home and the spec/plan pair |
| The old `scripts/check-expert-review.sh` (306 lines diverged) | **replaced, backup kept** | Same reason; the current copy ships the `.test.sh` canary it lacked |
| `docs/claude/roadmap.md`, `in-progress.md`, `worklog.md`, `architecture.md`, `key-patterns.md` | **not deleted — they never existed** | The old `AGENTS.md` pointed at five files that were absent; the kit template seeds roadmap + in-progress, and the rest stay uncreated rather than fabricated |

## Spec coverage

| Requirement | Where it landed | Verified by |
|---|---|---|
| FR-001 doctor + `panoply: OK` | `scripts/panoply.sh`, `.panoply-version` | `sh scripts/panoply.sh check` → exit 0 |
| FR-002 one home for rules, generated mirrors | `.agents/rules/*.md`, `scripts/sync-agents.sh` | `sh scripts/sync-agents.sh --check` |
| FR-003 plan home | `docs/agents/roadmap.md`, two-level folders | `sh scripts/check-plan-home.sh` |
| FR-004 AGENTS.md is the hub | `AGENTS.md` (22,460 B) | read: index, no bodies |
| FR-005 no deletions | `git status` shows renames and additions only | `git diff --stat --diff-filter=D` empty |
| FR-006 gates in CI | `.github/workflows/verify.yml` | the PR's `verify` run |
| FR-007 docs/spec/algorithm gates | `scripts/check-docs.sh`, `check-spec.sh`, `check-algorithm.sh` | each run locally, each green |

## Milestones

- **M1** — `migrate` copies the 14 adapted modules forward and reports the translation. Done.
- **M2** — `apply --force-scripts` seeds the 6 missing modules, the docs spine, 20 gate scripts, and
  refreshes the 3 diverged ones (backups written). Done.
- **M3** — `AGENTS.md` rebuilt from the kit template with fonto's project facts and the Next.js
  warning; rule bodies deleted. Done.
- **M4** — mirrors regenerated; `panoply check` green. Done.
- **M5** — docs spine written for real (roadmap, in-progress, this spec + plan), plans folded to the
  two-level home. Done.
- **M6** — gates wired into `verify.yml`, all green locally and in CI. Done.

## Findings outside this repo

1. **`panoply.sh migrate` aborts on a repo with no doctor.** `cmd_migrate` guards the doctor refresh
   with `[ -f "$_src/scripts/panoply.sh" ] && ! cmp -s ...`, which is true when the repo has no
   `scripts/panoply.sh`, and then runs `cp scripts/panoply.sh "$_dbak"` on a missing file. Under
   `set -eu` the whole migration stops after copying the rule modules and before `apply` — the exact
   adopter (exit 10, "absent") that most needs `apply`. Worked around here by seeding the doctor
   first. **Owner: the kit** (`/opt/data/panoply-kit`), reported to Radar.
2. **`check-rule-fork.sh` audits sibling checkouts of one workspace and exits 1 when it cannot reach
   them** (`<workspace>/a`, `pilot`, `repo`). It is a fleet audit tool, not a per-repo landing gate, so
   it is deliberately **not** wired into this repo's `verify.yml`.
3. **`check-algorithm.sh` is not in `apply`'s managed-script list**, so an adopter who runs `apply`
   alone never gets the gate `algorithm.md` cites. It was copied in here by hand, with its canary.
4. **`check-comments.sh` has no path filter and scans generated mirrors.** Every module it approves
   lands in `.agents/rules/*.mdc` and `.cursor/rules/*.mdc`, so a change that touches the rules is
   judged against its own copies — and the kit's `algorithm.md` headings ("Step 1 — Question every
   requirement") match the gate's own narration rule. Here it is skipped in CI only when the diff
   contains generated or vendored kit text, and the skip prints its reason; ordinary code changes
   still run it. **Owner: the kit.**
5. **`check-env-example.sh` reads `process.env.*` out of every tracked file, docs included.** Importing
   the kit's `agent-readiness` module (which names `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` as
   examples) broke the gate on variables no Fonto code reads. The scan is now limited to code and
   excludes the doctrine trees and the gate scripts themselves — a fix in the gate's own scope, not an
   exclusion of the three names.

## Open questions

- Deleting `.claude/rules/` and `docs/claude/` (Dustin's call; recorded in `in-progress.md`).
- Whether to report the `migrate` defect upstream by fixing it in the kit repo — that is a different
  repository and a different change.
