# Changelog

Notable changes to Fonto. Newest first.

This file is the worklog target for `scripts/check-docs.sh`: a commit that
changes code must update this file in the same commit.

## Unreleased

### Fixed — the ratchet can no longer be raised to make a red gate green, or skipped to make it green

Two follow-up defects, both in the gate itself:

- **One number, two stories.** The header said the internal-edge measurement was 1,563 (after the
  builtin fix) and the constant's own comment said 1,724 (before it), then called 1,400 "~90%" of
  that — which is 81.2%. A maintainer reading the constant would believe a tolerance the gate does
  not have, or raise the floor against the wrong base. Both comments now carry no percentage at
  all — the floor and its measurement are two constants, and the gate **computes** the ratio for its
  log line, so no comment can drift from the arithmetic.
- **A skip that looked green to the merge button.** On a pull request a failed `git fetch` of the
  base ref made `assertBaselineFloor()` print its SKIP and return `null`, and the gate exited 0.
  The skip is visible in the log and invisible to branch protection, which reads only the required
  `verify` conclusion — so the ratchet could be switched off and the check still pass. The CI
  `pull_request` step now passes `--require-base`, which turns a missing or unfetchable base ref
  into a named failure. Push and local runs still skip, with a printed line, because there is no
  base there.

`pnpm arch:baseline` was one command away from erasing any deletion the module ratchet was meant to
make visible: when the gate went red, re-recording the baseline was the cheap way out. On a pull
request the gate now counts tracked `.ts`/`.tsx` at `origin/<base>` and at HEAD with the same filter,
prints `base N · head M · baseline K`, and fails when the baseline exceeds the base — so lowering the
baseline is only possible from a tree that already earned the smaller number.

Both sides are counted from git, not from dependency-cruiser: comparing a cruise count at HEAD
against a git count at the base would mix two measurements and move when a dependency changed.

    arch-gate: baseline floor — base 559 · head 559 · baseline 544 (against `origin/main`)

When the base ref is not in the checkout the gate prints a `SKIP` line naming the ref and the reason
and does not pretend it checked. On a push there is no base, so the floor is a pull-request check by
design. It stops a baseline from growing; silent shrinkage is still caught by the existence check
that fails when a listed path leaves the tree, and is visible in the diff.

### Fixed — the gate counted modules and edges it never checked

Two numbers the gate already computed were printed and never asserted, and both are exactly the
numbers that go quiet when the resolver stops working. Measured on this tree today, by breaking the
`@/*` alias and running it:

| | healthy | alias broken | old gate's verdict |
|---|---|---|---|
| modules cruised (`totalCruised`) | 627 | **748** | fine — it went *up* |
| coverage ratio | 100.0% | **100.0%** | fine |
| policed layers cruised | 188/188 | **188/188** | fine |
| rule warnings | 242 | **51** | 79% of the enforcement gone, unreported |
| unresolvable imports | 0 | **1,267** | unreported |

A ratio floor cannot see that. Three assertions now do:

- **The module ratchet — `scripts/arch-baseline.json`.** The exact sorted list of
  **544 module paths `git ls-files` reports**, written by `pnpm arch:baseline`. Only tracked paths
  may enter it: an earlier cut filtered on "does not start with `node_modules/`", and because
  dependency-cruiser reports a Node builtin under its bare specifier, 13 builtins (`fs`,
  `child_process`, `path`, …) were recorded as if they were files — entries that would have failed
  the gate the day their last import was deleted, naming a file that never existed. Membership is
  now defined by `git ls-files`, and a baseline entry outside it fails the gate by name. Every listed
  path must still be cruised; a path leaves the list only in the PR that deletes the file. It is a
  path list and not a number on purpose: `totalCruised` is not a file count — 627 = 557 repo
  sources + 70 `node_modules/.pnpm` entries — and one broken alias moved it 627 → 748 with no file
  added or deleted, so any delta computed from it measures the resolver, not the tree. A path fails
  by name (`no longer cruised: lib/x.ts`), needs no merge-base and no `git diff`, and survives a
  shallow clone.
- **Zero unresolvable imports.** dependency-cruiser marks an import it could not resolve with
  `couldNotResolve` and still reports no violation. Each one is a dependency the rules cannot see,
  so any of them fails the gate with the `file -> specifier` line.
- **Internal-edge floor (`MIN_INTERNAL_EDGES = 1400`).** Measured **1,563** internal edges today,
  and the floor sits just under it — a ratio the gate computes and prints rather than a number a
  comment asserts, because files can be cruised while their imports stop becoming edges.

Canaried against this tree, each restored clean afterwards:

- `paths` deleted from `tsconfig.json` → exit 1, *1,267 imports did not resolve* plus *27 modules in
  the ratchet no longer exist in the tree*, while modules rose 627 → 748 and coverage still read
  100%. The old gate passed that state.
- one baseline module renamed out of the tree → exit 1, *1 module in the ratchet no longer exist in
  the tree — gone: lib/workspace.ts*.
- one baseline module retired by a temporarily broadened `options.exclude.path` → exit 1,
  *1 module in the ratchet is still in the tree but was NOT cruised*.

Restoring each returns `arch-gate: OK` at 557 modules / 1,724 internal edges — the counts as they
stood then; 161 of those "edges" were Node builtins and were removed later, and the numbers in this
entry predate the builtin fix, the module ratchet and the internal-edge floor.

### Changed — the architecture gate now checks the map it claims

`pnpm arch` was a bare `depcruise` run whose config held four containment rules about the
intelligence adapters and the credential secret-box. It enforced none of the four-layer map that
`.claude/rules/clean-architecture.md` commits to, and it asserted nothing about its own coverage —
a missing root `typescript` or a broadened `options.exclude.path` makes dependency-cruiser cruise
~0 modules and still print "no dependency violations found" with exit 0.

Now `scripts/check-architecture.mjs` is the gate. It refuses to run until it can prove it saw the
source: `typescript` resolves, the tsconfig exists, ≥90% of tracked `lib app worker scripts`
sources were cruised, and 100% of policed `lib/` sources were cruised **without** the config's
excludes applied. Then the map itself:

- `error` (0 violations today, blocking): `lib-no-ui`, `drivers-no-upward`, `no-circular`.
- `warn` (counted backlog, promoted to blocking at zero): `domain-stays-pure` 46 in 15 files,
  `application-no-drivers` 24 in 13, `adapters-no-drivers` 172 in 132 — 242 warnings over 627
  modules, printed every run.

One real cycle was fixed rather than baselined: `lib/storage/index.ts` re-exported `read.ts`,
which imported the barrel back for the backend singletons. The singletons moved to
`lib/storage/backends.ts`; both sides now point there and the public surface is unchanged.

Detection proven, not assumed: a planted `lib/ -> components/` import, a planted
`lib/db/ -> lib/processing/` import, and a planted barrel cycle each fail the gate and name their
rule; hiding `node_modules/typescript` makes the gate refuse rather than report success.

### Changed — Next.js 16.4.2 and sharp 0.35.5 (security)

`next` **16.2.1 → 16.4.2**, `eslint-config-next` in lockstep, `sharp`
**^0.34.5 → ^0.35.5**. OSV, queried against the two exact package versions:
**16.2.1 carries 34 advisories, 16.4.2 carries 0.** The 34 include both
unauthenticated RCEs fixed in 16.3.6 and 16.3.8, the `next/og` RCE, the
image-optimizer SSRF, the App Router middleware bypass, and the Server Actions
DoS (CVE-2026-94482).

Reachability as configured — checked, not assumed: `cacheComponents` is not
enabled, so the `use cache` typed-array path never executes, and no SVG image
optimization is enabled, so the optimizer RCE path is closed at configuration.
The DoS needs no precondition; that is the one this bump actually closes.

`sharp` is a resolved-path question, not a manifest one. The copy that matters
is the one `next` resolves from its own directory, and the version bump alone
would have left **0.34.5** there. `sharp` is a direct dependency now, and read
from inside `next` the resolved path is `sharp@0.35.5` — with the **musl**
prebuilds present in the lock, because the image is `node:22-alpine`.

`eslint-plugin-react-hooks` is pinned to **7.0.1** with a `pnpm.overrides` entry.
`eslint-config-next@16.4.2` asks for `^7.1.0`, and 7.1 turns
`react-hooks/set-state-in-effect` into 80 hard errors across this tree — none of
them new code. The pin keeps the lint gate behaving exactly as it does on
`main` (0 errors, 63 warnings) instead of smuggling a rule change into a
security bump.

Gates on this branch: `typecheck` clean · `arch` clean (623 modules, 2572
dependencies, no violations) · `conformance` clean · `build` clean with the full
route table and a written `BUILD_ID` · `lint` **0 errors**, 63 pre-existing
warnings. The Alpine image build was not exercised locally, and this repo has no
deploy-on-merge, so landing this does not move production by itself.

### Changed — fleet decoupling: Fonto is standalone (zero sibling-app coupling)

Fonto no longer depends on any sibling Joeybuilt app. The internal coupling —
the `@joeybuilt/plexo-sdk` facade, the boot-time app registration, the Plexo
vision client, a federated intelligence tier, two inbound routes a sibling
called, a health probe and a dashboard status badge — is gone, along with every
`PLEXO_*` environment variable. Pairing with a peer now happens through Fonto's
own PUBLISHED surface, and the AI tier is app-owned and user-configurable.

**Removed** (files deleted, dependencies dropped):

| Removed | Was |
|---|---|
| `@joeybuilt/plexo-sdk` | the sibling SDK — gone from `package.json` AND `pnpm-lock.yaml` |
| `lib/plexo.ts` | the SDK facade + deploy-shaped prompts |
| `lib/plexo-registration.ts` | app-profile registration at boot |
| `lib/plexo-vision.ts` | CLIP/OCR/face client bound to the sibling's URL + key |
| `lib/intelligence/adapters/plexo-{federated,unified}.ts` | the federated tier and the unified analyze-image client |
| `app/api/plexo/{data,events}`, `app/api/health/plexo` | inbound routes + health probe |
| `components/plexo*/**` | the peer status UI cluster |

**What replaced it:**

- **AI, stand-alone and user-configurable** — `fonto.ai_connections`
  (migration 0063) + `lib/ai/connections.ts`: per-user **label, base URL,
  model, API key**. The key is AES-256-GCM encrypted via the new single home
  `lib/crypto/secret-box.ts` (which `lib/integrations/tokenCrypto.ts` now
  delegates to, so existing Google-token ciphertext is untouched). Resolution
  per call: named connection → user default → deployment default
  (`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`; the legacy `FONTO_LLM_*` names are
  honored). No read path ever returns the key — masked last-4 only. Editable at
  **Settings → Integrations**.
- **Prompts are app-owned** — `lib/intelligence/prompts.ts` (classify,
  describe image/document, suggest tags), each taking the owning userId so the
  user's own connection serves the call.
- **Vision tier, own URL** — `lib/intelligence/adapters/vision-sidecar.ts`
  now reads only `FONTO_VISION_URL` (+ optional `FONTO_VISION_KEY`); unset
  means the capability is not advertised and callers degrade.
- **Semantic memory, app-owned** — `intelligence.storeMemory` /
  `searchMemory` against `fonto.intelligence_memory`; the search route's
  semantic re-rank embeds the query with the vision tier and ranks locally.
- **Published API** — `/api/peer/v1/data` (GET/POST) and `/api/peer/v1/events`
  (HMAC-SHA256 signed), authenticated by the deployment's own
  `FONTO_SERVICE_KEY`/`_V2` (`lib/peer/service-keys.ts`). Unconfigured ⇒ 503
  FEATURE_DISABLED, which is a supported state.
- **Jex manifest** — `public/.well-known/jex.manifest.json` plus an api route
  importing the same file, so the two can never diverge.

**The 503 anti-pattern is forbidden — nothing optional can kill a core flow.**
The pipeline lost its eager workspace resolution and its peer-first branch
entirely; a missing AI connection degrades to the CLIP argmax floor, a
skipped caption, or a typed `unavailable` — uploads, library, tags,
collections, sharing and sync never depend on AI.

**Also in this change:**

- `scripts/conformance-guard.mjs` is INVERTED: it now forbids the sibling SDKs
  (and re-pinned provider packages), forbids the removed `@/lib/plexo*`
  imports, and scans for `PLEXO_*` env reads — while keeping the asset LIST
  projection whitelist rule intact. It runs in `verify.yml` before typecheck.
- `.dependency-cruiser.cjs` encodes the app-owned boundary: the provider SDK
  lives only in `lib/intelligence/adapters/`, adapters are reached only via the
  intelligence facade, and `lib/crypto/secret-box.ts` is the single home for
  credential encryption.
- `.env.example` / `docker-compose.example.env` / `docker-compose.yml` document
  `AI_*`, `FONTO_VISION_URL`, `FONTO_SERVICE_KEY(_V2)` and drop every `PLEXO_*`
  variable; `scripts/provision-ai-default.mjs` seeds the operator's per-user
  default connection from the deployment env.
- The obsolete unified-analyze test was replaced with coverage for the new
  modules (secret box round-trip/tamper/format; peer service-key auth).


### Changed — retire the last Codemagic references; signing secrets renamed

Codemagic was already gone from the build path — `.pushd.yaml` has been the CI
plane for a while — but stale names remained: `.pushd.yaml`, `mobile/CI.md`,
`mobile/README.md` and `.claude/agents/fonto-mobile.md` all still pointed at
`codemagic.yaml`, and the signing env vars kept their Codemagic-derived `CM_*`
names even though pushd reads them. This removes every remaining reference and
moves the secrets onto pushd's own android-schema names.

Renames, applied end to end (`.pushd.yaml`, `mobile/android/app/build.gradle`):

| was | is |
|---|---|
| `CM_KEYSTORE_BASE64` | `ANDROID_KEYSTORE_BASE64` |
| `CM_STORE_PASSWORD` | `ANDROID_KEYSTORE_PASSWORD` |
| `CM_KEY_ALIAS` | `ANDROID_KEY_ALIAS` |
| `CM_KEY_PASSWORD` | `ANDROID_KEY_PASSWORD` |
| `CM_KEYSTORE_PATH` | `ANDROID_KEYSTORE_PATH` |

The four `ANDROID_*` secrets are the names pushd's android schema already
expects (`ANDROID_KEYSTORE_SECRETS` in `packages/build/src/schema/android.ts`),
so a hand-written `secrets:` list and the auto-generated signing commands now
agree — previously the hand-written list drove the `CM_*` path while pushd's own
generator would have injected `ANDROID_*`. Both entries (`android-release` on
`v*`, `android-publish` on `release-v*`) keep their triggers unchanged.

`mobile/CI.md` is rewritten against pushd: the two entry names and their tag
gates, the Docker/Flutter builder image, keystore rotation through the pushd
project secret store instead of Codemagic's UI, and a triage table keyed on the
new names. `mobile/README.md` drops the "Codemagic or GitHub macOS runner" lines
to "GitHub macOS runner" (Android already builds on pushd). The `fonto-mobile`
agent's scope line names `.pushd.yaml` rather than the removed `codemagic.yaml`,
and its "builds run in Codemagic" rule now says pushd.

Deployment side: the pushd project store for `fonto` must carry the four
`ANDROID_*` keys before the next `v*` tag, or the release build falls back to
debug signing.

### Changed — README rewritten and reconciled with the working install path

PR #3 rewrote `README.md` (1207 → 309 lines) from a cut at `cfc85d29`, before
the install-path fix landed on `main`. Merging the two left `README.md` as the
only conflicting file; it is resolved by hand against the merged tree, keeping
the rewrite's structure and honest tone while documenting the path that
actually works.

The Quick start now leads with `docker compose up -d` and the six `${VAR:?}`
values compose refuses to start without, and the bare-host path uses
`pnpm db:setup` — not `pnpm db:migrate` — with the three reasons
`drizzle-kit migrate` cannot drive this series stated inline. The compose
profiles, `Dockerfile.migrate`, `drizzle/baseline/` and
`docs/self-hosting.md` are all documented, and `pnpm db:push` is named as the
banned destructive command `AGENTS.md` already forbids.

Claims the rewrite carried from the pre-fix tree are corrected: the
`docker-compose.yml` and the migration runner now exist (it said neither did),
`REDIS_URL` defaults to loopback rather than a container DNS name (those two
literals were also the branch's only `scan-infra` R5 hits), there are five
Dockerfiles rather than four, CI runs on GitHub-hosted `ubuntu-latest` with a
`pull_request` trigger and does run `pnpm test`, and `PASSKEY_RP_ID` falls back
to `localhost` rather than to a production domain. Counts were re-verified
against the merged tree: 137 `/api/v1` route handlers, 62 numbered migrations
plus 2 baselines, 18 non-mobile `*.test.ts` (15 matched by `vitest.config.ts`),
136 allowlisted untested handlers, 11 middleware redirects, 6 unconditional and
6 opt-in repeatable jobs.

### Changed — `verify` moved to GitHub-hosted runners and gained a PR gate

`verify.yml` ran on `[self-hosted, hive]` with `push` + `workflow_dispatch`
only. It now runs on `ubuntu-latest` and also on `pull_request`, so a PR reports
a `verify` check that can be made **required** — previously fonto had no check
that ran on PRs at all, and an open PR carried zero check runs.

Two reasons the self-hosted pin no longer holds:

- **The reason it moved there is gone.** The header recorded that hosted jobs
  were rejected in Aug 2026 because the Free plan had burned its 2,000 included
  minutes. That allowance meters *private* repos; for public repos standard
  hosted runners are free and unlimited. fonto is public now.
- **Hosted is the safer runner for a public repo, and also the bigger one.**
  Public-repo `ubuntu-latest` is 4 vCPU / 16 GB, versus the 8 GiB the hive
  runners are capped at, so the `--max-old-space-size=6144` heap has more
  headroom than it did on self-hosted. And for a `pull_request` event GitHub
  takes the workflow from the PR's *merge commit*, so the fork controls the job
  body — acceptable on an ephemeral VM, unacceptable on a runner where the
  `docker`-labelled peer is uid=0 with `/var/run/docker.sock` mounted.

The header's INVARIANT block now records that this job must stay hosted, and why
it must never grow a `secrets.*` dependency (fork PRs receive none, so one would
fail every outside contribution). Steps are unchanged — 13 of them, byte-identical;
only the header, triggers, and `runs-on` differ. nexalog's `verify.yml` is the
proven precedent for the same trigger set on the same runner.

### Fixed — CI could not run at all

Two independent things kept `verify.yml` from ever executing, both discovered
only after #2 merged:

- **The org runner group blocked this repository.** `joeybuilt-official`'s
  `Default` self-hosted runner group had `allows_public_repositories: false`,
  so *no* public repo could schedule a job on `hive-ci-1` / `hive-ci-4`. Runs
  queued indefinitely with no annotation explaining why (Fonto and Plexo both
  had jobs stuck since 03:17 while private repos ran fine). Flipped to `true`
  after auditing all 8 workflows in both public repos: **zero** of them run a
  self-hosted job on a `pull_request` or `pull_request_target` trigger, so an
  untrusted fork PR cannot reach a runner. The only PR-triggered workflow
  (`plexo/changelog-check.yml`) uses GitHub-hosted runners.
- **`pnpm/action-setup@v4` rejected the pnpm pin #2 added.** The workflow
  already passed `version: 10`, and action-setup v4 errors out when a version
  is *also* present in `package.json`'s `packageManager` ("Multiple versions
  of pnpm specified"), failing at step 3 in ~11 s before any real work.
  Removed the redundant `version:` input so the action reads the pinned
  `packageManager` — the documented v4 pattern.

`pnpm build` was **not** broken, despite an earlier report that it was: that
diagnosis came from running bare `next build`, which defaults to Turbopack in
Next 16 and rejects this repo's `webpack` externals block. The real script is
`next build --webpack`; it passes (exit 0).

### Fixed — the infra scanner failed on its own tree

`pnpm scan:infra` reported 12 hits on the tree #2 shipped, so the gate #2 added
could never have passed. Because no public-repo CI had ever run (above), nothing
caught it. Three causes:

- **R2 was too broad.** It matched `/data/fonto-media`, but that is a container
  mount point *inside a named volume that this repo's own `docker-compose.yml`
  defines* — the app's internal layout that every self-hoster gets, not the
  deploy box's. Narrowed R2 back to the actual leak class (`/data/appdata`,
  `/data/_secrets`, `/data/backups`, `/mnt/user/`, `/opt/app/`).
- **`docker-compose.example.env` was missing from `ALLOW_R5_PATHS`** despite
  documenting each service's internal DNS name (`redis://valkey:6379`,
  `http://minio:9000`) as the value a compose deployer wants.
- **`lib/r2PathStyle.test.ts` was missing too.** Path-style resolution is
  decided *by* the endpoint host — minio needs it, R2/S3 must not — so those
  hostnames are the subject under test, not a leak.

Both additions are **rule-scoped to R5** (that array is only consulted for
`R5-internal-dns`), so they cannot silence another rule in those files. Proved
by negative control: injecting `https://myfonto.com` into
`docker-compose.example.env` still fires R1 *and* R6, and injecting
`ssh root@prod-box` into the test file still fires R3. `--self-test` still
detects all 8 rules (it seeds R2 via `/data/appdata`, so narrowing the pattern
did not blind it).

### Fixed — database setup on a fresh install

`pnpm db:migrate` could not work on this repository, for three independent
reasons, and it failed *silently* (exit 0, nothing applied):

- There is no `drizzle/meta/_journal.json`, so Drizzle's `readMigrationFiles()`
  threw before applying anything. A fresh clone therefore came up with an empty
  database while the command reported success.
- `drizzle/migrations/` starts at `0001_share_links.sql`, and `0002` immediately
  alters `fonto.assets` — but no numbered migration ever creates the base
  `fonto` tables. They had been created out-of-band.
- Drizzle wraps every pending migration in one transaction, and migrations
  `0037` and `0058` use `CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses
  inside a transaction block.

Added `drizzle/baseline/` (base `fonto` tables + the Better Auth `auth` schema)
and `scripts/db-apply.sh`, which drives `psql` directly and is now the supported
path: `pnpm db:setup`, with `--dry-run` and `--adopt` modes. Verified end to end
against a fresh PostgreSQL 16 + pgvector database: 64/64 files applied, 48
`fonto` tables, 4 `auth` tables, no invalid indexes.

### Fixed — the `auth` schema was never created

`lib/auth.ts` opens its pool with `search_path=auth`, but nothing in the repo
created that schema or the Better Auth tables, and Better Auth's `$context` does
not create tables on its own. A fresh install could not sign in even with the
`fonto` schema present. The baseline DDL is dumped from Better Auth 1.6.9
itself rather than hand-written (columns, indexes and foreign keys verified
against the library's own generated schema).

### Fixed — `--adopt` could stamp an empty database

`db-apply.sh --adopt` recorded every migration as applied without checking that
the schema existed, so pointing it at an empty database produced a green log and
an install that could never serve a request (every later run would skip
everything). It now refuses unless `fonto.assets` or `auth."user"` is present.

### Added — self-hosting install path

- `docker-compose.yml` — Postgres/pgvector, Valkey, MinIO, web, worker, a
  one-shot `migrate` service the app waits on, and opt-in profiles for
  `bullboard`, `backup`, `observability`, `selfhosted` (Caddy TLS) and
  `autoscaler`. No production hostname, host path or credential is baked in.
- `Dockerfile.migrate` — a minimal image carrying only `db-apply.sh` and the
  SQL, so a migration run cannot import application code.
- `docker-compose.example.env`, `docs/self-hosting.md`, and an `ops/caddy/`
  Caddyfile.
- `.env.example` completed: every variable the code reads is now documented,
  with the real defaults read off the source rather than guessed.

### Added — infrastructure-identifier guard

`scripts/scan-infra-identifiers.sh` (`pnpm scan:infra`) blocks committed
production hostnames, deploy-box paths, container DNS names, internal database
names and routable IPs, with `--self-test` planting one canary per rule to prove
the scanner detects rather than passing vacuously. Development domains,
documentation IP ranges (RFC 5737) and the localhost defaults are deliberately
not findings.

### Changed — production identifiers removed

Every reference to the maintainers' own domains, host paths and internal service
names was replaced with an environment variable or a documented placeholder
(`<YOUR_APP_ORIGIN>`, `<host-path>`). Two of these were also documentation bugs:
the README claimed `REDIS_URL` defaulted to a container DNS name (it defaults to
`localhost`; a container name cannot resolve on a bare host) and that
`PLEXO_VISION_URL` had a default (it throws when unset, by design).

### Changed — CI

`pnpm test` now runs in `verify.yml` before the build, so a unit-test failure
reports in seconds instead of surfacing as a failed 6 GiB `next build`.
