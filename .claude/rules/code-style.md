# Code Style & Patterns

> Applies to all source changes. Match nearby code before introducing a new convention.

## Before writing

- Read the target module and its closest sibling first.
- Prefer an existing file and pattern over a new abstraction.
- Decide the architecture layer before choosing a directory.
- Do not add unrequested refactors, dependencies, or compatibility paths.

## Fonto conventions

| Concern | Verified convention |
| --- | --- |
| Exports | Library modules use named exports; Next.js page/layout entrypoints commonly use default exports. A sample of 10 library files had named exports. |
| Internal imports | Use the `@/*` TypeScript alias for root-relative imports. |
| File/symbol naming | `camelCase.ts` for library modules, `kebab-case.tsx` for most shared UI files, PascalCase for React symbols, and `route.ts` for Next route handlers. |
| UI tokens | Use `lib/design-tokens.ts` and `--ft-*` variables in `app/globals.css`; do not add ad-hoc brand colors. |
| Persistence | Use `db` and `schema` from `lib/db/`; do not create a second database client. |
| Mechanical checks | `pnpm lint`; no formatter script is configured. Preserve nearby formatting and let ESLint decide lint rules. |

## Boundaries

- Business rules do not import ORM, HTTP, UI, queue, filesystem, or vendor code; see `clean-architecture.md`.
- Upload HTTP flows use `lib/upload-client.ts` or `lib/upload-client-tus.ts` where applicable.
- No shared typed API client exists today. Existing web components use same-origin `fetch`; keep calls at page or hook boundaries, type responses locally, and align public shapes with `lib/openapi/`.
- Route handlers currently contain direct Drizzle queries. New code should avoid widening that gap and keep persistence decisions in the existing data boundary.
- Values used across a boundary come from one owning module. Do not duplicate status, role, MIME, or event unions.

## Dead code

When removing the last caller of a route, screen, export, feature flag, or config key, search string and dynamic references before deleting the now-unreachable code.
