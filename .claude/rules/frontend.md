# Front-End Engineering

> Applies to the Next.js 16 App Router web UI and its React 19 client components.

## Placement

- Dashboard pages and route-level UI live under `app/(app)/app/`.
- Generic primitives live under `components/ui/`.
- Product-aware dashboard components live under `app/(app)/app/_components/`; shared product components live under `components/`.
- Pages wire data to components and own route loading/error/empty states. Keep business decisions out of them.

## State and data

- Start with local state; lift only to the nearest common parent.
- Server data is not app state. The web app has no TanStack Query, SWR, or other shared fetch cache; existing screens use effects and local state. Keep loading, empty, and error branches explicit and refresh affected local state after mutations.
- No shared typed API client exists. Keep same-origin `fetch` at page or dedicated-hook boundaries, type responses locally, and align paths and envelopes with `lib/openapi/`.
- Use `lib/upload-client.ts` and `lib/upload-client-tus.ts` for their upload flows rather than duplicating upload protocol logic.
- Issue independent requests in parallel; do not create request waterfalls in nested components.

## Required states

Every async page, form, upload, and background save has a visible loading state, a useful empty state, and an actionable error state. Errors are logged with operation and record context; failures are never swallowed to leave a stale spinner or optimistic value.

## Accessibility and performance

- Use real buttons and links; every control has an accessible name and visible focus.
- Meet WCAG AA contrast, do not encode meaning by color alone, and honor reduced motion.
- Give images dimensions and meaningful or empty alt text.
- Virtualize or paginate long library lists. Memoize only after measuring a problem.
- Keep effects narrowly scoped with honest dependencies.
