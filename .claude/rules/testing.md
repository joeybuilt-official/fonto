# Testing

> **Applies when:** the project has an automated test suite, or is about to get one.
> **Delete this file (and its `@` import in `CLAUDE.md`) if:** the project has no test runner and none is planned.

## Testability is a design signal, not a fixture problem

- **Domain and use-case logic must be testable with no database, no HTTP, and no framework boot.** Construct the thing, call it, assert the result. This is the single most reliable check that the Dependency Rule held (see `clean-architecture.md`) — you cannot fake it, because a rule that reaches outward simply will not run without the outer layer.
- **If a test of a business rule needs a live schema, a running server, or the framework's test harness, that is a design defect the test is reporting.** Fix the design — move the rule inward, put a port where the reach-out is — rather than adding the fixture that makes the symptom go away. The fixture is cheaper today and is the reason the suite is slow in a year.
- Say it out loud when you hit one. "This needed a database to test, so I extracted a port" is a finding worth reviewing; silently adding infrastructure to a unit test is not.

## The pyramid maps onto the layers

- **Wide, fast base — Entities/Domain and Use Cases/Application.** Pure in-process tests, no I/O, milliseconds each. Most tests live here because most behaviour should. These are the tests you can afford to run after every edit.
- **Middle band — Interface Adapters and Frameworks & Drivers.** Test each adapter against the real thing it adapts: a real database for a repository, a real round-trip for an HTTP client, the real serializer for a mapper. An adapter tested against a mock of its own dependency asserts nothing except that you wrote the mock to match your assumption.
- **Thin top — end-to-end.** A handful of paths proving the wiring holds. If you find you need many end-to-end tests before you feel safe, that is evidence business rules are living in the outer layers, where only an end-to-end test can reach them.

## Baseline

- Write unit tests for all business logic: validation, data transformations, calculations, state machines, permission checks, formatting. Logic without a test is a behaviour nobody can change safely later.
- **Run `pnpm test:e2e` after every change**, not just at the end of a task. A failure found one edit later is a two-minute fix; found ten edits later it is a bisect.
- If tests fail, fix the code until they pass before moving on. Report the failure — never continue building on a red suite.
- **Never skip, `.only`, comment out, or delete a failing test to get green.** A skipped test is an untested behaviour plus a false signal, which is worse than no test. If a test is genuinely obsolete because the behaviour was removed, delete it in the same change that removes the behaviour, and say so.
- Do not filter or spot-check the run. Run the full suite, unfiltered, before committing.


## Enforced endpoint test coverage

Every endpoint must have a test, and CI must be the thing that says so. Reviewers forget; a job does not.

> **If the enforcement machinery below does not exist in this project yet** (no check script, no allowlist), it is the target state, not a description of current CI — the adapt setup offers to scaffold it (~30 lines walking the route manifest). Until it exists, follow rules 1–3 by discipline and say so in PRs; do not assert CI behavior that is not wired.

**1. Mirror the source tree in the test tree.** For an endpoint at `app/api/<path>/<name>.<ext>`, its test lives at `e2e/<path>/` under the project's test-discovery naming convention — suffix style (`<name>.test.<ext>`) or prefix style (`test_<name>.<ext>`), whichever the runner actually collects. A mechanical mapping means the coverage check needs no configuration and no judgement call about where a test "should" go.

**2. Detect endpoints exactly, not by heuristic.** Derive the endpoint list from the same manifest the application itself uses — the router registration file, the route table, the handler index. Deriving it from filename patterns produces both false positives and, worse, silent false negatives.

**3. New endpoint and its test ship in the SAME change.** A separate follow-up PR for tests is never written. CI fails the change if an endpoint file has no matching test file, and the error message names the exact missing path so the fix is obvious.

**4. Legacy gaps live in a shrink-only allowlist.** Endpoints that predate this rule are listed in `scripts/endpoint-test-allowlist.yaml` (one path per line, no wildcards).
   - **CI refuses net-new entries.** The check compares the allowlist against the default branch's version and fails if it grew. The only direction it moves is shorter.
   - **Touching an allowlisted file means writing its test in the same change and deleting its allowlist entry.** Also enforced in CI. This turns every visit to legacy code into a small, permanent payment against the debt, instead of a project nobody schedules.
   - Never add an entry to unblock yourself. If you believe an exception is warranted, stop and ask the user.

**5. `target:` no endpoint-coverage check is wired yet.** Fonto has no unit/route test runner today — only Playwright e2e (`e2e/`) plus ad-hoc `tsx scripts/test-*.ts` probes. Until a check exists, follow rules 1–4 by discipline and say so in PRs; do not assert a CI gate that is not there.

## What an endpoint test asserts

- Success status code and the exact response shape (field names, types, nesting).
- Each validation failure path and the status/error body it produces.
- Not-found and forbidden paths for any resource looked up by id.
- Pagination, filtering, and sorting parameters if the endpoint accepts them.


## Mocking

- **Mock the authentication/authorization middleware to inject a fixed test user.** Endpoint tests exist to test the endpoint; re-testing auth in every endpoint file makes each test slower, flakier, and coupled to the auth implementation. Test auth once, in its own suite.
- **Inject a fake through the port rather than patching a module.** The data layer stays out of the test — no live database, service, or network — because the use case receives its repository/gateway as a dependency and the test hands it an in-memory implementation. Real dependencies make tests order-dependent, environment-dependent, and slow, and they fail for reasons that have nothing to do with the change under review.
- Injection beats patching for a concrete reason: a patch keyed on a module path breaks the moment someone moves the file, and it silently stops patching anything if the path is wrong, while a constructor or parameter argument is checked by the compiler and cannot miss.
- Mock at the boundary the code actually calls (the client module, the repository), not deeper. Mocking internals couples the test to implementation details and it breaks on every refactor. **If there is no port to inject at, that is a finding — record it.** When the code is yours to change in this same effort, add the port. When you are testing existing conventionally-structured code, patching the module at the boundary it calls is an acceptable interim — note the missing port rather than blocking the test on an architecture refactor nobody approved.

### Sequentially-consumed mocks go stale — watch for this

Many mocking styles queue results and hand them out **in call order**. So when you add a query to an existing parallel batch (a `Promise.all`, a concurrent fetch group, a transaction block), the queued mock results shift by one and every downstream assertion is now reading the wrong row.

- After changing the number or order of calls in a batch, **update the mock push order in every affected test file** in the same change.
- The failure mode is silent: tests can still pass while asserting against the wrong data. If a test keeps passing after you changed the query it covers, treat that as a red flag and verify the mock alignment by hand.
- Prefer mocks keyed by argument over positional queues where the framework allows it — they survive reordering.

## Before you commit

- Full test run, unfiltered: `pnpm test:e2e`.
- Endpoint coverage check: `target:` none wired yet (see the coverage note above).
- Verify assertions match any new response shape — dropped fields, renamed fields, changed types — rather than assuming an untouched test still tests what it claims.
