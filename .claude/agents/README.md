# Agent Library

Subagents Claude Code can spawn for focused work. Each runs in its own context window and returns a written result to the caller — so the win is **isolation and depth**, and the cost is that the caller never sees the agent's reasoning, only its final report.

**The general rule:** do it inline when you already know the file and the fix. Spawn an agent when the work needs its own sweep of the codebase, its own long output, or a reviewer who has not already convinced themselves the code is fine.

| Agent | What it's for | Reach for it when — vs. inline |
|---|---|---|
| `backend-architect` | Server-side system design: services, schemas, APIs, caching, scale | **Agent:** a new subsystem, a data model that will outlive the sprint, an endpoint set to design. **Inline:** adding one field or one route to an existing pattern. |
| `code-reviewer` | Correctness, security, maintainability, and performance review of a diff | **Agent:** any non-trivial diff, and always before merge — a fresh context catches what the author's cannot. **Inline:** a one-line change you can re-read in ten seconds. |
| `cto-review` | Long-horizon review of a plan, design, or milestone; Critical/Significant/Minor verdict | **Agent:** milestone plans, architectural decisions, anything with cross-cutting impact. **Inline:** never — the value is the independent judgment. |
| `database-optimizer` | Index selection, query plans, N+1 elimination, migration safety | **Agent:** a slow query, a schema for a table that will grow, a migration touching live data. **Inline:** adding a nullable column with an obvious index. |
| `frontend-developer` | Building UI: components, state, performance, accessibility | **Agent:** a whole screen or feature, or a performance problem needing measurement. **Inline:** copy tweaks, one prop, a styling nudge. |
| `security-engineer` | Threat modeling, secure code review, vulnerability assessment, hardening | **Agent:** anything touching auth, uploads, secrets, external input, or permissions. **Inline:** never for auth-adjacent code — that's where inline confidence is most often wrong. |
| `software-architect` | Domain modeling, pattern selection, trade-off analysis, ADRs | **Agent:** a decision that is expensive to reverse, or where two credible options exist. **Inline:** decisions the project's rules already settle. |
| `ui-designer` | Design systems, tokens, component specs, visual foundations | **Agent:** a new component family, a token/theme change, a design system from scratch. **Inline:** reusing an existing component as intended. |
| `ui-reviewer` | Pixel-level review: spacing, type, hierarchy, design-system drift | **Agent:** after implementing any new screen, before calling it done. **Inline:** when you changed no layout or spacing. |
| `ux-architect` | CSS architecture, layout frameworks, theming, information architecture | **Agent:** greenfield UI foundations, or a layout system that keeps getting re-litigated. **Inline:** a project with a mature design system already in place. |
| `ux-designer` | Competitive research, user flows, interaction patterns | **Agent:** before building a feature whose interaction model is genuinely open. **Inline:** a flow that mirrors one the product already has. |
| `ux-researcher` | Study design, usability testing, personas, evidence-graded findings | **Agent:** when a decision hinges on user behavior you're guessing at. **Inline:** never guess and call it research — if there's no data, ask this agent for a study plan. |

All of them read `CLAUDE.md` and the relevant `.claude/rules/*.md` modules first; project rules outrank agent defaults, and an agent that contradicts a rules module is reporting a bug in one of the two. Every agent operates under the `.claude/rules/clean-architecture.md` premise — the Dependency Rule and its four layers are assumed, not renegotiated per agent.

**Add an agent:** drop a new `.md` here with frontmatter (`name` matching the filename, plus `description` — the description is what Claude matches on when choosing an agent, so make it say *when* to use it, not just what it is), then give it a role, non-negotiable rules, a repeatable process, and an explicit output contract.

**Delete the ones you don't need:** just remove the file — nothing imports it, and a smaller library makes agent selection sharper. A backend-only project should delete the five `u[ix]-*` design agents (`ui-designer`, `ui-reviewer`, `ux-architect`, `ux-designer`, `ux-researcher`) plus `frontend-developer`; a project with no database should delete `database-optimizer`.
