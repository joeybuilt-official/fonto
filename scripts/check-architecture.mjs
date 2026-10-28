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
//      becoming edges; the coverage ratio reads 100% in exactly that state. Measured 1,563 after
//      builtins stopped counting as internal edges (they were 161 of the old 1,724), floored at
//      ~90%.
//
// THE LAYER RULES, AND THE HONEST LADDER (measured 2026-10-28, 620 modules cruised)
//   `error` — clean today, so blocking from day one:
//     lib-no-ui            lib/ -> components/ or app/                       0 violations
//     drivers-no-upward    lib/{db,queue,storage} -> any inner layer        0 violations
//     no-circular          any cycle                                        1, fixed in this change
//   `warn` — a real backlog this change makes VISIBLE, counted every run, not fixed by fiat:
//     domain-stays-pure      lib/{fusion,evidence,temporal,stacks,classify,faces} -> outside  46 / 15 files
//     application-no-drivers lib/processing -> db/storage/queue/adapters                        24 / 13 files
//     adapters-no-drivers    app/api + lib/openapi -> db/storage/queue                        172 / 132 files
//   The `warn` rules are the report-only ramp the doctrine prescribes for a non-conforming repo.
//   They print every run; the moment a rule reaches zero it moves to `error` and starts blocking.
//
// GATE SEMANTICS. The violation report and exit code come from dependency-cruiser's own `err`
// reporter (`format()`), so the CI log and the pass/fail semantics are exactly what a bare
// `depcruise` run produced. Real violations still fail; warnings still don't.
//
// USAGE
//   node scripts/check-architecture.mjs                  # the gate (`pnpm arch`)
//   node scripts/check-architecture.mjs --write-baseline # re-record BOTH ratchets (reviewed!)
//
// POSIX-friendly, no runtime deps beyond depcruise's own. Node 22 (CI) / 26 (local).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * Internal-edge floor — measured 1724 on main 2026-10-28, floored at ~90%. A count that is printed
 * and never asserted is a log line, not a check: if the resolver stops producing edges (a broken
 * `paths` alias turns 1,199 of them into unresolvable stubs) the coverage ratio above can still read
 * 100% while the rules police almost nothing. Raise this constant only in a PR that shows the
 * higher measured count.
 */
const MIN_INTERNAL_EDGES = 1400
/** Below this, source discovery itself is broken (no git, wrong roots) — fail rather than divide by ~0. */
const MIN_EXPECTED_SOURCES = 50
/** Path prefixes whose tracked sources the rules act on: all must be cruised. */
const POLICED_PREFIXES = [
  'lib/',
]
/** Cruise roots that must each contribute at least one cruised module. */
const KEY_AREAS = ['lib/', 'app/']
/**
 * Observed on main 2026-10-28, for context in the counts line only. Not asserted — see the header.
 */
const HEALTHY_BASELINE = { modules: 620, dependencies: 2566, known: 0 }

const problems = []
const fail = (headline, details) => problems.push({ headline, details })

// ---------------------------------------------------------------------------------------------
// Preconditions: the inputs whose absence degrades depcruise silently.
// ---------------------------------------------------------------------------------------------
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
if (!WRITE_BASELINE && !existsSync(path.join(ROOT, BASELINE))) {
  fail(`the known-violations baseline ${BASELINE} is missing`, [
    'the ratchet cannot be applied, so every grandfathered violation would fail the gate at once.',
    `record it once, deliberately, with: pnpm arch:baseline`,
  ])
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
      `repo-owned modules ${repoModules.length} · internal edges ${internalEdges} · ` +
      `repo modules ${repoModules.length} (baseline ${moduleBaseline ? moduleBaseline.repo_modules.length : 'n/a'}) · ` +
      `baseline ${HEALTHY_BASELINE.modules}/${HEALTHY_BASELINE.dependencies}`,
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
    console.error(`  ✖ ${headline}`)
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
      `    4. \`${BASELINE}\` or \`${MODULE_BASELINE}\` missing — record both with \`pnpm arch:baseline\`.`,
      '',
      '  the gate itself lives in scripts/check-architecture.mjs; the rules in .dependency-cruiser.cjs;',
      '  the layer map is .claude/rules/clean-architecture.md; the ratchet is this file header.',
      '',
    ].join('\n'),
  )
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
else if (!WRITE_BASELINE) console.log('arch-gate: OK — violation report above; coverage asserted.')
