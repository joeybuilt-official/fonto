# Photos vs Files split — plan workspace

Working directory for the Photos / Files structural-split initiative. The
operator's brief lives in the prompt that opened this session; the converged
panel plan should land at `plan.md` in this directory.

## Expected layout

- `plan.md` — converged panel plan (the single source of truth)
- `panel/` — per-expert deliberation notes (delete or fold into `plan.md`
  once the plan converges)
- `ia.md` — information architecture: surfaces, lens chips, route map
- `decisions.md` — the 10 open decisions resolved, one per heading, with
  the reason recorded
- `risks.md` — devil's-advocate risk register
- `telemetry.md` — events + dashboards
- `rollout.md` — sequencing (flag gates, sweep, validation)

## Current state at the time this stub was created (2026-06-22)

- Mobile lens chips today: `mobile/lib/src/screens/home_screen.dart` →
  `_LensSelector`, `_lens` string state.
- Web lens chips today: `app/(app)/app/library/page.tsx` → `LENSES` array.
- KIND derivation: `lib/classify/kind.ts` (ADR 0001). Do not modify in this
  task.
- Server backfill running: 14k captured assets draining after plexo enum
  fix `ed54c7e` (2026-06-22). Live `kind` distribution recorded in the
  brief.
- Already shipped to mobile under existing lens model (relevant priors):
  - `4719a86` — on-device strip respects lens filter (`device_kind.dart`)
  - `f90d04d` — gate `_offline` banner on real Connectivity state
  - Tag `v2.0.362` — current.

## Do NOT

- Run `scripts/classify-only-rerun.ts` from inside the panel session.
  Produce the sweep wrapper + checklist; the operator invokes it.
- Tune `lib/classify/kind.ts` rules as a side quest.
- `git add -A` / `git add .` — stage by file.
- Skip web/mobile parity. Both ship together or neither.
