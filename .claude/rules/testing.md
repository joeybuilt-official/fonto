# Testing

> Applies to Fonto's browser, unit, route, worker, and SDK checks.

## Test inventory

- Root browser suite: `pnpm test:e2e`, configured by `playwright.config.ts` with `testDir: ./e2e`.
- Focused unit tests are colocated under `lib/`; the SDK has its own `pnpm --filter @joeybuilt/fonto-sdk test` script.
- The root package has no aggregate unit-test script. Do not call `pnpm test` as if it existed.
- Route source is `app/api/v1/`; the OpenAPI route registry is `lib/openapi/routes.ts`.

## Testability

- Pure rules and use cases should run without a database, server, network, or framework boot.
- Test adapters at the boundary they call. Prefer injected fakes where a port exists; mock auth at the route boundary for route tests.
- When query count or order changes, inspect every sequential mock in the affected tests; passing assertions can still be reading the wrong result.
- Never skip, `.only`, comment out, or delete a failing test to get green.

## API coverage discipline

`pnpm tsx scripts/check-openapi-coverage.ts --strict` compares exported methods in `app/api/v1/` with `REGISTERED_ROUTES` in `lib/openapi/routes.ts`. It checks OpenAPI registration, not endpoint tests. No route-test coverage script, allowlist, or CI workflow exists today.

- Register every new `/api/v1` route in `lib/openapi/routes.ts` and run the check.
- Add behavior coverage in the nearest applicable suite. Existing browser tests live in `e2e/`; existing unit tests are colocated in `lib/`.
- Route tests should cover status, exact response shape, validation failures, authz/not-found paths, and accepted pagination/filtering.

## Required validation

- Root browser validation: `pnpm test:e2e`.
- SDK validation: `pnpm --filter @joeybuilt/fonto-sdk test`.
- Full root typecheck and lint: `pnpm typecheck` and `pnpm lint`.
- OpenAPI registration: `pnpm tsx scripts/check-openapi-coverage.ts --strict`.
