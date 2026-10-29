// check-architecture.mjs — `pnpm arch`, wrapped so it cannot pass vacuously.
//
// WHAT WAS WRONG BEFORE THIS FILE
//   `arch` was a bare `depcruise --config .dependency-cruiser.cjs lib app worker scripts`, and the
//   config held four containment rules about the intelligence adapters and the credential secret-box.
//   It enforced NONE of the four-layer map that `.claude/rules/clean-architecture.md` commits to, and
//   it asserted nothing about its own coverage — so a degraded cruise (root `typescript` missing, an
//   over-broad `options.exclude.path`) printed "no dependency violations found" and exit 0 while the
//   layer map was violated 243 times in the tree. A required check that passes having done nothing is
//   worse than no check: it turns an open question into a false assurance.
//
// WHAT IT ASSERTS NOW
//   1. `typescript` resolves from the repo root, and the tsconfig the config points at exists.
//      These are the two inputs whose absence makes depcruise degrade silently (~0 modules, exit 0).
//   2. Overall coverage: cruised tracked in-scope sources >= MIN_COVERAGE (90%) of all tracked
//      in-scope sources — the denominator is `git ls-files <roots>` filtered to .ts/.tsx, i.e.
//      CONFIG-INDEPENDENT. It is deliberately not derived from `options.exclude.path`, because that
//      config is the thing being policed: letting it define "in scope" would let a broadened exclude
//      shrink numerator and denominator together and keep the ratio at 100%.
//      A ratio, never an exact module count: a healthy cruise reports a slightly different module
//      count across environments, so an exact constant would make the gate itself flaky.
//   3. Policed-layer coverage: EVERY tracked source under `lib/` — the directory every blocking rule
//      acts on — must have been cruised. 100% by construction, checked WITHOUT applying the config's
//      excludes, so a broadened `options.exclude.path` cannot quietly retire files from the rules'
//      reach.
//   4. Key areas present: at least one cruised module from each cruise root — a direct check that
//      the roots resolve at all.
//   5. THE MODULE RATCHET (scripts/arch-baseline.json → `repo_modules`): the exact sorted list of
//      module paths that `git ls-files` reports, written by `pnpm arch:baseline`. Every listed path must still be cruised.
//      This is a path list and not a number for a measured reason: `totalCruised` is not a file
//      count — 627 = 557 repo sources + 70 `node_modules/.pnpm` entries on 2026-10-28 — and
//      breaking one `@/*` alias moved it 627 -> 748 with no file added, while 1,199 internal edges
//      turned into stubs. Arithmetic on that number measures the resolver, not the tree. A path
//      fails by name (`no longer cruised: lib/x.ts`), needs no merge-base and no `git diff`, and
//      works in a shallow clone. The count is printed as a derived value; it is never the bound.
//   6. ZERO UNRESOLVABLE IMPORTS. dependency-cruiser marks an import it could not resolve with
//      `couldNotResolve` and, by default, still reports no violation. Every such import is an edge
//      the rules cannot see, so any of them fails the gate.
//   7. INTERNAL-EDGE FLOOR (MIN_INTERNAL_EDGES). Files can be cruised while their imports stop
//      becoming edges; the coverage ratio reads 100% in exactly that state. The floor is a fraction
//      of MEASURED_INTERNAL_EDGES, and that fraction is COMPUTED — read it off the run line
//      (`floor 1400 = N% of the M measured`), never off a comment. A typed percentage is a second
//      copy of the arithmetic and goes stale the first time either constant moves.
//   8. BASELINE INTEGRITY (20261028-1a). A known-violations file stops describing the tree in two
//      ways, and both used to be silent. A rule is renamed or its severity moves, and the baseline
//      keeps matching a name the config no longer declares that way. A baselined violation's file is
//      deleted or renamed, and the entry can never fire again while the count still claims it is
//      known. Checked here:
//        - (name, severity) SET EQUALITY: every distinct pair in the baseline must be declared in
//          `.dependency-cruiser.cjs` at exactly that severity — so a rename, a demotion, or an entry
//          for a rule that no longer exists fails by name.
//        - NO DEAD ENTRIES: every baselined `from`/`to` naming a repo path must still be a cruised
//          module. External targets (`node_modules/...`) are exempt: they are not modules of this repo.
//      `--self-test` runs ten cases over these two checks, six of them expected to fail, so a future
//      simplification that makes either check vacuous breaks the suite instead of the gate going quiet.
//
// THE LAYER RULES — ALL TEN BLOCK (20261028-1a)
//   Every rule in the config is `error`. The three that used to be `warn` were promoted once their
//   backlog was recorded in `.dependency-cruiser-known-violations.json`: the difference between "a new
//   violation of this rule" and "a violation we already had" is now the BASELINE, not the severity.
//   A `warn` severity is a rule nobody can fail — it prints on every run forever. A baseline fails on
//   anything new and can only shrink.
//     domain-stays-pure      lib/{fusion,evidence,temporal,stacks,classify,faces} -> outside  46 / 15 files, baselined
//     application-no-drivers lib/processing -> db/storage/queue/adapters                        24 / 13 files, baselined
//     adapters-no-drivers    app/api + lib/openapi -> db/storage/queue                        172 / 132 files, baselined
//   Measured 2026-10-28: 242 baselined, 0 new. Re-recording is a reviewed act (`pnpm arch:baseline`),
//   not the way out of a red gate.
//
// GATE SEMANTICS. The violation report and exit code come from dependency-cruiser's own `err`
// reporter (`format()`), so the CI log and the pass/fail semantics are exactly what a bare
// `depcruise` run produced. A new violation fails; a baselined one is counted and named as known.
//
// USAGE
//   node scripts/check-architecture.mjs                      # the gate (`pnpm arch`)
//   node scripts/check-architecture.mjs --base origin/main   # + the BENCH-10 baseline floor
//   node scripts/check-architecture.mjs --base origin/main --require-base   # CI pull_request path
//   node scripts/check-architecture.mjs --write-baseline     # re-record BOTH ratchets (reviewed!)
//
// `--require-base` turns a missing or unfetchable base ref into an ERROR instead of a printed SKIP.
// CI passes it on `pull_request`, where the event supplies a base and a silent skip would leave the
// required `verify` check green with the ratchet switched off.
//
// POSIX-friendly, no runtime deps beyond depcruise's own. Node 22 (CI) / 26 (local).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The baseline's two honesty checks, written as pure functions so `--self-test` can drive them
// without a tree, a cruise, or a mutation. The gate calls the same code on real data.
/** rule name -> the severity `.dependency-cruiser.cjs` declares for it. */
function configRuleSeverities(config) {
  const map = new Map()
  for (const rule of config?.forbidden ?? []) {
    if (typeof rule?.name === 'string') map.set(rule.name, rule.severity ?? 'error')
  }
  return map
}

/**
 * A baseline target counts as ours only if it names a path in this repository. depcruise records an
 * external target as `node_modules/.pnpm/<pkg>/...`, which is not a module of this repo and must not
 * be judged stale — the package is installed, it is simply not crawled.
 */
const isRepoPath = (value) =>
  typeof value === 'string' && /^(lib|app|worker|scripts|components)\//.test(value)

/**
 * The two ways a known-violations baseline stops describing the tree: a rule's identity changed, or a
 * baselined violation can no longer fire. Returns one entry per broken check — never throws, so the
 * self-test can drive it with garbage.
 */
function assertBaselineIntegrity({ baseline, config, cruisedModules }) {
  const problems = []
  if (!Array.isArray(baseline)) {
    return [
      {
        headline: 'the known-violations baseline is not an array of violations',
        details: [
          'it is written by `pnpm arch:baseline`; a hand-edited or truncated file cannot be enforced.',
          'with no baseline every grandfathered violation would fail the gate at once.',
        ],
      },
    ]
  }

  const pairs = new Map()
  for (const row of baseline) {
    const name = row?.rule?.name
    const severity = row?.rule?.severity
    if (typeof name !== 'string' || typeof severity !== 'string') {
      return [
        {
          headline: 'a known-violations entry has no `rule.name` / `rule.severity`',
          details: [
            'every entry must name the rule and the severity it was recorded at, or the set check',
            'below compares against nothing and passes.',
          ],
        },
      ]
    }
    const key = `${name}\u0000${severity}`
    pairs.set(key, (pairs.get(key) ?? 0) + 1)
  }

  const severities = configRuleSeverities(config)
  const undeclared = []
  const drifted = []
  for (const key of pairs.keys()) {
    const [name, severity] = key.split('\u0000')
    if (!severities.has(name)) undeclared.push(name)
    else if (severities.get(name) !== severity) {
      drifted.push(`${name} (baseline \`${severity}\`, config \`${severities.get(name)}\`)`)
    }
  }
  if (undeclared.length > 0) {
    problems.push({
      headline:
        `${undeclared.length} rule name(s) in the baseline are not declared in .dependency-cruiser.cjs`,
      details: [
        'a renamed or deleted rule can never fire again, so its entries grandfather nothing while the',
        'run line still counts them as known. Re-record deliberately: `pnpm arch:baseline`.',
        ...[...new Set(undeclared)].slice(0, 10).map((name) => `  - baseline rule \`${name}\` is not in the config`),
      ],
    })
  }
  if (drifted.length > 0) {
    problems.push({
      headline: `${drifted.length} rule(s) changed severity without the baseline being re-recorded`,
      details: [
        'the baseline is matched on (name, severity). A rule promoted or demoted under a stale entry is',
        'silently unenforced: the entry matches nothing, and the rule it names no longer exists that way.',
        ...drifted.slice(0, 10).map((line) => `  - ${line}`),
      ],
    })
  }

  const cruised = new Set(cruisedModules)
  const deadEntries = baseline
    .filter((row) => isRepoPath(row?.from) && !cruised.has(row.from))
    .map((row) => `${row.rule?.name}: ${row.from} is no longer cruised`)
    .concat(
      baseline
        .filter((row) => isRepoPath(row?.to) && !cruised.has(row.to))
        .map((row) => `${row.rule?.name}: ${row.from} -> ${row.to} is no longer cruised`),
    )
  if (deadEntries.length > 0) {
    problems.push({
      headline: `${deadEntries.length} baselined violation(s) can no longer fire — the entry is dead`,
      details: [
        'a baselined file was deleted or renamed, so this entry grandfathers nothing and the count on',
        'the run line overstates the debt. Delete the entry in the PR that moves the file.',
        ...deadEntries.slice(0, 10).map((line) => `  - ${line}`),
      ],
    })
  }

  return problems
}

/** Ten cases over the two checks above — six expected to fail. Exit 2 on any mismatch. */
function runSelfTest() {
  const rule = (name, severity) => ({ name, severity })
  const config = { forbidden: [rule('r-a', 'error'), rule('r-b', 'error'), rule('r-c', 'error')] }
  const entry = (name, severity, from, to) => ({ rule: rule(name, severity), from, to })
  const cruised = ['lib/a.ts', 'lib/b.ts', 'app/api/x/route.ts']
  const external = 'node_modules/.pnpm/drizzle-orm@0.45.2/node_modules/drizzle-orm/index.d.ts'
  const cases = [
    ['empty baseline, every rule declared', [], config, 0],
    ['a matching (name, severity) pair', [entry('r-a', 'error', 'lib/a.ts', 'lib/b.ts')], config, 0],
    ['a rule name the config no longer declares', [entry('r-gone', 'error', 'lib/a.ts', 'lib/b.ts')], config, 1],
    ['a rule whose severity moved', [entry('r-a', 'warn', 'lib/a.ts', 'lib/b.ts')], config, 1],
    ['a baselined `from` that is no longer cruised', [entry('r-a', 'error', 'lib/gone.ts', 'lib/b.ts')], config, 1],
    ['a baselined `to` that is no longer cruised', [entry('r-a', 'error', 'lib/a.ts', 'lib/gone.ts')], config, 1],
    ['an external `to` is not stale', [entry('r-a', 'error', 'lib/a.ts', external)], config, 0],
    ['a baseline that is not an array', { nope: true }, config, 1],
    ['duplicate rows collapse to one pair', [
      entry('r-a', 'error', 'lib/a.ts', 'lib/b.ts'),
      entry('r-a', 'error', 'lib/a.ts', 'lib/b.ts'),
    ], config, 0],
    ['an entry with no rule identity', [{ from: 'lib/a.ts', to: 'lib/b.ts' }], config, 1],
  ]
  let failed = 0
  for (const [label, baseline, cfg, expected] of cases) {
    const got = assertBaselineIntegrity({ baseline, config: cfg, cruisedModules: cruised }).length
    const ok = got === expected
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — ${got} problem(s), expected ${expected}`)
  }
  console.log(
    failed === 0
      ? `arch-gate self-test: OK — ${cases.length} cases, ${cases.filter((c) => c[3] > 0).length} of them negative.`
      : `arch-gate self-test: FAIL — ${failed}/${cases.length} case(s) did not match expectation.`,
  )
  return failed === 0
}

if (process.argv.includes('--self-test')) {
  process.exit(runSelfTest() ? 0 : 2)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Cruise roots — kept identical to the old script's arguments. */
const ROOTS = ['lib', 'app', 'worker', 'scripts']
const CONFIG = '.dependency-cruiser.cjs'
const BASELINE = '.dependency-cruiser-known-violations.json'
/**
 * The module ratchet: the exact sorted list of REPO-OWNED module paths the cruise saw, recorded by
 * `pnpm arch:baseline` and enforced as a floor. See "the module ratchet" in the header for why this
 * is a path list and not a number.
 */
const MODULE_BASELINE = 'scripts/arch-baseline.json'
const DEPCRUISE_BIN = path.join(ROOT, 'node_modules', '.bin', 'depcruise')
const WRITE_BASELINE = process.argv.includes('--write-baseline')

/** Minimum fraction of tracked in-scope sources the cruise must have seen. */
const MIN_COVERAGE = 0.9
/**
 * Internal-edge floor — a fraction of MEASURED_INTERNAL_EDGES below, never a typed percentage: the
 * ratio is `floorPercent()`, printed on every run. A count that is printed and never asserted is a
 * log line, not a check: if the resolver stops producing edges (a broken `paths` alias turns 1,199
 * of them into unresolvable stubs) the coverage ratio above can still read 100% while the rules
 * police almost nothing. Raise this constant only in a PR that shows the higher measured edge count
 * — and read the resulting percentage off the run line rather than writing it into this comment.
 */
const MIN_INTERNAL_EDGES = 1400
/** The measurement the floor above is a fraction of — change one, change both. */
const MEASURED_INTERNAL_EDGES = 1563
/**
 * The percentage the prose quotes, derived rather than typed.
 *
 * The previous revision of this file claimed "1,724 measured, floored at ~90%" beside a constant of
 * 1,400 — 81.2%, not 90%, against a measurement that had itself been corrected to 1,563 in the
 * header. Two comments disagreed about what one number meant. Computing it here means the ratio in
 * the log cannot drift from the constants, and any prose that contradicts it is visibly wrong.
 */
const floorPercent = () => ((MIN_INTERNAL_EDGES / MEASURED_INTERNAL_EDGES) * 100).toFixed(1)
/** Below this, source discovery itself is broken (no git, wrong roots) — fail rather than divide by ~0. */
const MIN_EXPECTED_SOURCES = 50
/** Path prefixes whose tracked sources the rules act on: all must be cruised. */
const POLICED_PREFIXES = [
  'lib/',
]
/** Cruise roots that must each contribute at least one cruised module. */
const KEY_AREAS = ['lib/', 'app/']
// No typed "healthy" module/dependency pair lives here any more. It printed `baseline 620/2566` beside
// `repo modules 544 (baseline 544)` — two different quantities both called "baseline", neither asserted,
// and stale since the last dependency change. A number this file prints must come from the run it is
// printing (20261028-005).

const problems = []
const fail = (headline, details) => problems.push({ headline, details })

/**
 * The ref this run is compared against — the base branch of a pull request.
 *
 * Passed explicitly, and only explicitly: `--base <ref>` or `--base=<ref>`. An environment fallback
 * was the first draft and it was wrong for two reasons — it put a second, invisible input into a
 * gate whose whole justification is that it says what it checked, and it made the gate read two
 * variables that are CI-provided rather than configuration, which `check:env-example` correctly
 * refuses to let `.env.example` lie about. CI passes `--base origin/<base>`; a run without it (a
 * push, a local `pnpm arch`) has no base to compare against and the floor check does not apply.
 */
const BASE_REF = (() => {
  const index = process.argv.indexOf('--base')
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((arg) => arg.startsWith('--base='))
  if (inline) return inline.slice('--base='.length)
  return null
})()

/**
 * Set by CI on the `pull_request` path, where the event already supplies a base ref.
 *
 * Without it, a missing ref is a printed SKIP and exit 0 — correct for a push or a local shallow
 * clone, where there is genuinely no base to compare against. On a pull request that same SKIP is
 * invisible to branch protection: `verify` is fonto's required context, so a failed `git fetch`
 * would switch the ratchet off and still paint the check green. The script was never mistaken; the
 * merge button was, and the merge button is the reader that matters.
 */
const REQUIRE_BASE = process.argv.includes('--require-base')

// Preconditions: the inputs whose absence degrades depcruise silently.
const require = createRequire(path.join(ROOT, 'package.json'))

try {
  require.resolve('typescript')
} catch (error) {
  fail('root `typescript` does not resolve from the repo root', [
    'dependency-cruiser cannot build a TS project without it, and then cruises ~0 modules',
    'while reporting success — this is the silent no-op this guard exists to catch.',
    `resolve failed: ${error.code ?? error.message}`,
  ])
}
// dependency-cruiser is ESM-only, so it has no CJS `require.resolve` entry point. Check the
// installed package directory instead — the dynamic `import("dependency-cruiser")` below is the
// real consumer, and a missing install is what this precondition is guarding against.
if (!existsSync(path.join(ROOT, 'node_modules', 'dependency-cruiser', 'package.json'))) {
  fail('`dependency-cruiser` is not installed at the repo root', [
    'it is a root devDependency and the cruise cannot run without it.',
    'install the root devDependencies: npm ci',
  ])
}
if (!existsSync(DEPCRUISE_BIN)) {
  fail(`depcruise binary not found at ${path.relative(ROOT, DEPCRUISE_BIN)}`, [
    'install dependencies first: npm ci',
  ])
}
if (!existsSync(path.join(ROOT, CONFIG))) {
  fail(`${CONFIG} is missing`, [
    'the architecture rules live there; without the config there is no gate to run.',
  ])
}
let moduleBaseline = null
if (!WRITE_BASELINE && !existsSync(path.join(ROOT, MODULE_BASELINE))) {
  fail(`the module ratchet ${MODULE_BASELINE} is missing`, [
    'without it the gate can only assert a ratio, and a ratio is exactly what an alias break',
    'defeats: the module count RISES while the edges the rules act on disappear.',
    'record it once, deliberately, with: pnpm arch:baseline',
  ])
} else if (!WRITE_BASELINE) {
  try {
    moduleBaseline = JSON.parse(readFileSync(path.join(ROOT, MODULE_BASELINE), 'utf8'))
  } catch (error) {
    fail(`the module ratchet ${MODULE_BASELINE} is not valid JSON`, [String(error.message)])
  }
  if (moduleBaseline && !Array.isArray(moduleBaseline.repo_modules)) {
    fail(`the module ratchet ${MODULE_BASELINE} has no \`modules\` array`, [
      'it is written by `pnpm arch:baseline`; a hand-edited shape cannot be enforced.',
    ])
    moduleBaseline = null
  }
}
/**
 * The baseline may never exceed the module count at the base commit (BENCH-10).
 *
 * A ratchet that can be raised whenever the gate goes red is not a ratchet: the cheap way out of a
 * failure becomes "regenerate the baseline", which erases the very deletions it was meant to make
 * visible. Requiring `baseline <= base` means lowering the baseline is only possible from a tree
 * that already earned the smaller number, so the exit from a red gate is deleting code or fixing
 * the import — not re-recording.
 *
 * Both sides are counted the same way, from git, over the same set: every tracked `.ts`/`.tsx` in
 * the repository — not just the cruise roots, because the ratchet's entries come from all of
 * `git ls-files` and a narrower denominator would fail the gate on a correct baseline. That is
 * deliberate: the alternative is comparing depcruise's head count against a git count of the base,
 * which mixes two measurements and moves on a dependency change alone.
 */
function assertBaselineFloor() {
  if (WRITE_BASELINE || !moduleBaseline) return null
  if (!BASE_REF) {
    if (REQUIRE_BASE) {
      return {
        headline:
          '`--require-base` was passed but no base ref was given — the ratchet cannot be checked',
        details: [
          'pass `--base <ref>` (CI passes `origin/<base>` on pull_request), or drop `--require-base`.',
          'this fails rather than skipping because on a pull request a skip leaves the required',
          'check green with the ratchet unenforced, which is the failure this rule exists for.',
        ],
      }
    }
    console.log(
      'arch-gate: baseline floor NOT checked — no `--base <ref>` given (local run, or a push event ' +
        'where there is no base). Pass `--base origin/<branch>` to compare against a base commit.',
    )
    return null
  }
  const countSources = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => /\.tsx?$/.test(file)).length
  let baseCount
  try {
    baseCount = countSources(['ls-tree', '-r', '--name-only', BASE_REF])
  } catch (error) {
    const reason = String(error.stderr ?? error.message ?? error).split('\n')[0].trim()
    if (REQUIRE_BASE) {
      return {
        headline:
          `base ref \`${BASE_REF}\` is not available in this checkout (${reason}) — required on this path`,
        details: [
          'the base ref was required, so this is a failure and not a skip: an unchecked ratchet must',
          'never leave a required check green. Fetch the ref (`git fetch origin <base>`) or fix the',
          'ref name CI passes.',
        ],
      }
    }
    console.log(
      `arch-gate: SKIP — baseline floor NOT checked: base ref \`${BASE_REF}\` is not available ` +
        `in this checkout (${reason}).`,
    )
    console.log(
      'arch-gate: a skip is printed rather than assumed; fetch the ref (`git fetch origin ' +
        '<base>`) or pass `--base <ref>` to check it.',
    )
    return null
  }
  const headCount = countSources(['ls-files'])
  const listed = moduleBaseline.repo_modules.length
  console.log(
    `arch-gate: baseline floor — base ${baseCount} · head ${headCount} · baseline ${listed} ` +
      `(against \`${BASE_REF}\`)`,
  )
  if (listed > baseCount) {
    return {
      headline:
        `the module ratchet lists ${listed} paths but the base commit \`${BASE_REF}\` only had ` +
        `${baseCount} — the baseline grew above its own floor`,
      details: [
        `base ${baseCount} · head ${headCount} · baseline ${listed}`,
        'a baseline may shrink in the PR that deletes files; it may never grow. Re-recording is',
        'the escape this rule removes: if the ratchet is red, delete code or repair the import.',
        'if this PR genuinely adds modules, the baseline stays where it was — it is a floor of',
        'paths that must keep being cruised, not a census of the tree.',
      ],
    }
  }
  return null
}

const floorFailure = assertBaselineFloor()

let knownBaseline = null
if (!WRITE_BASELINE && !existsSync(path.join(ROOT, BASELINE))) {
  fail(`the known-violations baseline ${BASELINE} is missing`, [
    'the ratchet cannot be applied, so every grandfathered violation would fail the gate at once.',
    `record it once, deliberately, with: pnpm arch:baseline`,
  ])
} else if (!WRITE_BASELINE) {
  try {
    knownBaseline = JSON.parse(readFileSync(path.join(ROOT, BASELINE), 'utf8'))
  } catch (error) {
    fail(`the known-violations baseline ${BASELINE} is not valid JSON`, [String(error.message)])
  }
}

// The tsconfig the cruise actually reads, taken from the config itself so the two cannot drift.
let cfg = null
let tsconfig = 'tsconfig.json'
if (existsSync(path.join(ROOT, CONFIG))) {
  cfg = require(path.join(ROOT, CONFIG))
  tsconfig = cfg?.options?.tsConfig?.fileName ?? tsconfig
  if (!existsSync(path.join(ROOT, tsconfig))) {
    fail(`${tsconfig} is missing`, [
      'the monorepo needs ONE TS project spanning apps/ + packages/ for `@/*` aliases and',
      'workspace imports to resolve; without it depcruise silently cruises almost nothing.',
    ])
  }
}

// ---------------------------------------------------------------------------------------------
// The cruise — identical roots/config as the old script, machine-readable output. Always JSON:
// the coverage assertions below need the module list, in baseline mode too.
// ---------------------------------------------------------------------------------------------
let cruise = null
if (problems.length === 0) {
  const result = spawnSync(
    DEPCRUISE_BIN,
    [
      ...ROOTS,
      '--config',
      CONFIG,
      ...(WRITE_BASELINE ? [] : ['--ignore-known', BASELINE]),
      '--output-type',
      'json',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  try {
    cruise = JSON.parse(result.stdout ?? '')
  } catch {
    fail(
      `depcruise did not produce a cruise result (exit ${result.status})`,
      [
        (result.stderr ?? '').trim(),
        'the config or tsconfig could not be read — see the causes listed below.',
      ].filter(Boolean),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Render the violation report and take the exit code from dependency-cruiser itself, so the CI
// log and the pass/fail semantics are exactly what a bare `depcruise` run produced.
// ---------------------------------------------------------------------------------------------
let violationExitCode = 0
if (cruise) {
  const { format } = await import('dependency-cruiser')
  if (!WRITE_BASELINE) {
    const rendered = await format(cruise, {
      outputType: 'err',
      reporterOptions: cfg?.options?.reporterOptions ?? {},
    })
    const text = String(rendered.output ?? '').replace(/\x1b\[[0-9;]*m/g, '')
    if (text.trim()) process.stdout.write(`${text.replace(/\s+$/, '')}\n`)
    violationExitCode = Number(rendered.exitCode) || 0
  }

  // ---- coverage accounting ----
  const trackedSources = execFileSync('git', ['ls-files', ...ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /\.tsx?$/.test(file))

  // EVERY path git knows about, unfiltered. The module ratchet is a list of paths *in this
  // repository*, and `git ls-files` is the only config-independent definition of that. Filtering by
  // "does not start with node_modules/" was not enough: dependency-cruiser reports a Node builtin
  // under its bare specifier (`fs`, `child_process`, `path`), so that filter wrote 13 builtins into
  // the ratchet — entries that would fail the gate the day the last import of them was deleted,
  // over files that never existed.
  const trackedAll = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )

  const cruised = new Set((cruise.modules ?? []).map((module) => module.source))
  const covered = trackedSources.filter((file) => cruised.has(file))
  const missed = trackedSources.filter((file) => !cruised.has(file))

  const expectedPoliced = trackedSources.filter((file) =>
    POLICED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  const coveredPoliced = expectedPoliced.filter((file) => cruised.has(file))
  const missingPoliced = expectedPoliced.filter((file) => !cruised.has(file))

  // Files the config's own exclude patterns retire from the cruise. Printed so a broadened
  // exclude is visible in the log even when the ratio still clears the floor.
  const excludePatterns = [].concat(cfg?.options?.exclude?.path ?? [])
  const excludeRe = excludePatterns.length > 0 ? new RegExp(excludePatterns.join('|')) : null
  const excludeRetired = excludeRe ? trackedSources.filter((file) => excludeRe.test(file)) : []
  const excludeRetiredPoliced = excludeRetired.filter((file) =>
    POLICED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )

  const moduleCount = cruise.summary?.totalCruised ?? (cruise.modules ?? []).length
  const dependencyCount = cruise.summary?.totalDependenciesCruised ?? 0
  const ratio = trackedSources.length > 0 ? covered.length / trackedSources.length : 0

  // ---- the module ratchet and the two counts a ratio cannot see ----
  // Repo-owned means "a path in this repository", not `node_modules/.pnpm/...`. The module list is
  // a ratchet: a path recorded at baseline may not stop being cruised, because a module that stops
  // being cruised takes every rule that acts on it out of the gate's reach.
  const repoModules = (cruise.modules ?? [])
    .map((module) => module.source)
    .filter((source) => trackedAll.has(source))
  const repoTrackedByGit = trackedAll
  const repoModuleSet = new Set(repoModules)
  const internalEdges = (cruise.modules ?? []).reduce(
    (total, module) =>
      total +
      module.dependencies.filter(
        (dependency) => typeof dependency.resolved === 'string' && repoModuleSet.has(dependency.resolved),
      ).length,
    0,
  )
  const unresolvable = (cruise.modules ?? []).flatMap((module) =>
    module.dependencies
      .filter((dependency) => dependency.couldNotResolve)
      .map((dependency) => `${module.source} -> ${dependency.module}`),
  )

  const pct = (value) => `${(value * 100).toFixed(1)}%`
  console.log(
    `arch-gate: ${moduleCount} modules / ${dependencyCount} dependencies cruised · ` +
      `tracked sources covered ${covered.length}/${trackedSources.length} (${pct(ratio)}) · ` +
      `policed layers covered ${coveredPoliced.length}/${expectedPoliced.length} · ` +
      `new violations ${cruise.summary?.error ?? 0} errors / ${cruise.summary?.warn ?? 0} warnings · ` +
      `known (baselined) ${cruise.summary?.ignore ?? 0} ignored · ` +
      `retired by exclude.path ${excludeRetired.length} · ` +
      `repo-owned modules ${repoModules.length} · internal edges ${internalEdges} ` +
      `(floor ${MIN_INTERNAL_EDGES} = ${floorPercent()}% of the ${MEASURED_INTERNAL_EDGES} measured) · ` +
      `repo modules ${repoModules.length} (baseline ${moduleBaseline ? moduleBaseline.repo_modules.length : 'n/a'}) · ` +
      `known-violations baseline ${Array.isArray(knownBaseline) ? knownBaseline.length : 'n/a'} entries`,
  )

  if (trackedSources.length < MIN_EXPECTED_SOURCES) {
    fail(
      `only ${trackedSources.length} tracked sources discovered (expected ≥ ${MIN_EXPECTED_SOURCES})`,
      [
        'source discovery is broken, so a coverage ratio would be meaningless:',
        '  - is this a full git checkout? `git ls-files` must list the sources',
        `  - do the cruise roots still exist (${ROOTS.join(', ')})?`,
      ],
    )
  } else if (ratio < MIN_COVERAGE) {
    fail(
      `cruise coverage ${pct(ratio)} is below the ${pct(MIN_COVERAGE)} floor ` +
        `(${covered.length}/${trackedSources.length} tracked sources cruised)`,
      [
        'a degraded cruise reports success while seeing almost none of the codebase.',
        ...missed.slice(0, 20).map((file) => `  - not cruised: ${file}`),
        missed.length > 20 ? `  - … and ${missed.length - 20} more` : null,
      ].filter(Boolean),
    )
  }

  if (missingPoliced.length > 0) {
    fail(
      `${missingPoliced.length} policed source file(s) were NOT cruised — ` +
        `the architecture rules silently do not apply to them`,
      [
        ...missingPoliced.slice(0, 20).map((file) => `  - ${file}`),
        excludeRetiredPoliced.length > 0
          ? `  note: ${excludeRetiredPoliced.length} of them are retired by ${CONFIG} → ` +
            '`options.exclude.path` — each entry is an unanchored regex matched against the ' +
            'whole path, so `build` also excludes `lib/build-prompt.ts`. Anchor with (^|/)…(/|$).'
          : null,
      ].filter(Boolean),
    )
  }

  if (unresolvable.length > 0) {
    fail(
      `${unresolvable.length} import(s) did not resolve — the rules cannot see a dependency that ` +
        'is not there',
      [
        'each line below is an import that LOOKS internal and resolves to nothing: a renamed',
        'directory, a broken `paths` alias, or a dependency that is not installed. Every edge it',
        'would have made is missing from the graph, so the rules silently stop covering it.',
        ...unresolvable.slice(0, 20).map((line) => `  - ${line}`),
        unresolvable.length > 20 ? `  - … and ${unresolvable.length - 20} more` : null,
        'fix the import or delete it — do not allow-list it: the rule it hides is the reason this',
        'gate exists.',
      ].filter(Boolean),
    )
  }

  if (internalEdges < MIN_INTERNAL_EDGES) {
    fail(
      `only ${internalEdges} internal edges resolved (floor ${MIN_INTERNAL_EDGES}) — the graph is ` +
        'missing its wiring',
      [
        'files were cruised but their imports did not become edges, so the layer rules ran against a',
        'skeleton. The coverage ratio above can read 100% in exactly this state, which is why the',
        'edge count is asserted and not merely printed.',
      ],
    )
  }

  if (moduleBaseline) {
    const listed = moduleBaseline.repo_modules
    const foreign = listed.filter((entry) => typeof entry !== 'string' || !trackedAll.has(entry))
    if (foreign.length > 0) {
      fail(`${MODULE_BASELINE} lists ${foreign.length} entry/entries that are not paths in this repository`, [
        'every entry must come from `git ls-files`. `node_modules/.pnpm/...` moves with the lockfile',
        'and cannot be a bound; a Node builtin (`fs`, `child_process`) is not a file at all and would',
        'fail the gate the day its last import was deleted, naming a file that never existed.',
        ...foreign.slice(0, 10).map((entry) => `  - ${String(entry)}`),
      ])
    } else {
      const cruisedNow = new Set(repoModules)
      const stillTracked = listed.filter((entry) => !cruisedNow.has(entry) && repoTrackedByGit.has(entry))
      const vanished = listed.filter((entry) => !cruisedNow.has(entry) && !repoTrackedByGit.has(entry))
      if (stillTracked.length > 0) {
        fail(
          `${stillTracked.length} module(s) in the ratchet are still in the tree but were NOT cruised — ` +
            'the rules no longer reach them',
          [
            'this is the alias/rename failure a coverage ratio cannot see: the file exists, the module',
            'count can even rise, and yet the rules that used to act on it are dead.',
            ...stillTracked.slice(0, 20).map((entry) => `  - baseline module ${entry} is no longer cruised`),
            stillTracked.length > 20 ? `  - … and ${stillTracked.length - 20} more` : null,
          ].filter(Boolean),
        )
      }
      if (vanished.length > 0) {
        fail(
          `${vanished.length} module(s) in the ratchet no longer exist in the tree`,
          [
            'a path leaves this list only in the PR that deletes the file, so the deletion is visible',
            'in review. Re-record deliberately with: pnpm arch:baseline',
            ...vanished.slice(0, 20).map((entry) => `  - baseline module ${entry} is gone from the tree`),
            vanished.length > 20 ? `  - … and ${vanished.length - 20} more` : null,
          ].filter(Boolean),
        )
      }
    }
  }

  // 20261028-1a — the baseline must still describe THIS tree: every (name, severity) pair it records
  // must be declared in the config, and every entry must name modules the cruise still reaches.
  //
  // Skipped under `--write-baseline`, which IS the act of re-recording: that run loads no baseline at
  // all, so these checks would read `null` and fail the gate on the one action the baseline exists to
  // allow. Before this guard the write path could not run once a single entry was dead — the ratchet
  // recorded a baseline it was then forbidden to move, which is a floor nobody can lower.
  if (!WRITE_BASELINE) {
    for (const problem of assertBaselineIntegrity({
      baseline: knownBaseline,
      config: cfg,
      cruisedModules: repoModules,
    })) {
      fail(problem.headline, problem.details)
    }
  }

  const absentAreas = KEY_AREAS.filter(
    (area) => !(cruise.modules ?? []).some((module) => module.source.startsWith(area)),
  )
  if (absentAreas.length > 0) {
    fail(
      'no cruised module found for key area(s)',
      absentAreas.map((area) => `  - ${area}`),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------------------------
if (problems.length > 0) {
  console.error('\narch-gate: FAIL — the architecture gate could not verify its own coverage.\n')
  for (const { headline, details } of problems) {
    console.error(`  FAIL ${headline}`)
    for (const line of details ?? []) console.error(`      ${line}`)
  }
  console.error(
    [
      '',
      '  likely causes, in order of likelihood:',
      '    1. root `typescript` missing — run `npm ci` at the repo root.',
      '       Without it depcruise cruises ~0 modules and reports "no violations".',
      `    2. \`${tsconfig}\` missing, renamed, or not resolving — the monorepo needs one TS project.`,
      `    3. cruise roots wrong (\`${ROOTS.join(' ')}\`) or ${CONFIG} → \`options.exclude.path\``,
      '       too broad: every exclude entry is an unanchored regex matched against the whole',
      '       path, so `build` also excludes `lib/build-prompt.ts`. Anchor with (^|/)…(/|$).',
      `    4. \`${BASELINE}\` or \`${MODULE_BASELINE}\` missing or stale — record both with \`pnpm arch:baseline\`,`,
      '       and run `node scripts/check-architecture.mjs --self-test` to check the integrity logic itself.',
      '',
      '  the gate itself lives in scripts/check-architecture.mjs; the rules in .dependency-cruiser.cjs;',
      '  the layer map is .claude/rules/clean-architecture.md; the ratchet is this file header.',
      '',
    ].join('\n'),
  )
}

if (problems.length === 0 && !WRITE_BASELINE && floorFailure) {
  // No fixed prefix: the two ways to get here are "the baseline grew" and "the base ref was
  // required and missing", and a headline that names the first for both would be the same defect
  // this file was just repaired for — a label that reads as a checked fact.
  console.error('\narch-gate: FAIL — the baseline floor could not be satisfied.\n')
  console.error(`  FAIL ${floorFailure.headline}\n`)
  for (const line of floorFailure.details) console.error(`      ${line}`)
  console.error('')
}

if (problems.length === 0 && WRITE_BASELINE && cruise) {
  // Only reachable with a full-coverage cruise, so a degraded run can never record a baseline.
  const { format } = await import('dependency-cruiser')
  const rendered = await format(cruise, { outputType: 'baseline' })
  writeFileSync(path.join(ROOT, BASELINE), String(rendered.output ?? ''))

  const trackedAllSet = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const repoModules = (cruise.modules ?? [])
    .map((module) => module.source)
    .filter((source) => trackedAllSet.has(source))
    .sort()
  const head = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch {
      return 'unknown'
    }
  })()
  writeFileSync(
    path.join(ROOT, MODULE_BASELINE),
    `${JSON.stringify(
      {
        // Written by `pnpm arch:baseline`. A FLOOR of repo-owned module paths: every one of these
        // must still be cruised, and a path leaves only in the PR that deletes the file.

        measured_at: head,
        repo_modules: repoModules,
      },
      null,
      2,
    )}\n`,
  )
  console.log(
    `arch-gate: wrote ${BASELINE} (${cruise.summary?.violations?.length ?? 0} entries) and ` +
      `${MODULE_BASELINE} (${repoModules.length} repo-owned module paths) — ` +
      'review the diff before committing; both are ratchets, not allowlists.',
  )
}

if (violationExitCode !== 0) process.exitCode = violationExitCode
else if (problems.length > 0) process.exitCode = 1
else if (floorFailure) process.exitCode = 1
else if (!WRITE_BASELINE) console.log('arch-gate: OK — violation report above; coverage asserted.')
