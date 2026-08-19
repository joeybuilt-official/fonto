
# Front-End Engineering

> **Applies when:** the project builds a client-side application (`React 19 + Next.js 16 (App Router)` components, views, routes, and client state).
> **Delete this file (and its `@` import in `CLAUDE.md`) if:** the project has no user interface — a library, CLI, service, or job runner. Pair it with `design-system.md`, which covers how the UI should *look*; this file covers how it should be *built*.

## The UI is a Detail

- **View components render and dispatch; they do not decide.** Whether a record is valid, eligible, overdue, or permitted is a business rule, and it never lives inline in a component or a hook — a rule embedded in a component cannot be tested without rendering it, and it gets re-implemented slightly differently on the next screen. In a client-server product the authoritative copy lives server-side, in the domain layer behind the API; in a client-only app it lives in a plain domain module the component calls. See `clean-architecture.md`.
- **The `/api/v1/*` HTTP surface is the adapter** between this layer and everything behind it. `target:` fonto has no single typed client yet — uploads go through `lib/upload-client.ts` / `-tus.ts` and other calls use raw `fetch`. Every rule below about going through it follows from that: call the adapter, never reach past it.
- Derived *presentation* state — formatting, sort order, which chip to show — is this layer's job. Derived *business* state — is this at risk, may this user approve it — is not. The client may mirror a business rule for instant feedback (disabling a button, inline validation), but the server's answer is the real one and the server always re-enforces it: a client-computed rule the server doesn't check is a rule every other client is free to break.

## File organization

- `components/ui` — generic, product-unaware primitives. They take props, emit events, and know nothing about the domain. A primitive that imports a domain type is no longer a primitive.
- `components` — components that know the product's nouns. Compose them from primitives; see `design-system.md` for the "assemble before you invent" rule.
- `app/ route groups (app/(app), app/(auth), app/admin)` — one file per route. Pages wire data to components and own the route's async states; they should contain little markup of their own.
- One component per file, named the same as the file, exported by name. A file that exports three components hides two of them from search and from reuse.
- Extract a subcomponent when a piece is reused, or when a file grows past the point where its render is readable in one screen — not merely because a file is long. Splitting a linear render into six files makes it harder, not easier, to follow.

## State

- **Colocate state with the component that uses it.** Start with local state; it is the only kind that cannot desynchronize.
- **Lift state only when two siblings must agree on it**, and lift exactly to their nearest common parent — no higher. State parked at the root re-renders the whole tree and turns every read into prop-drilling.
- **Reach for global/context state only when the value is genuinely app-wide** (session/user, theme, feature flags) or when lifting would thread a prop through four or more layers. Say why in the code or the PR, because global state is the hardest thing here to remove later.
- **Server data is not application state.** Fetch it in Server Components or a dedicated hook (`target:` no client cache like React Query/SWR is installed); do not copy it into local state "so it's easier to edit" — you then own an invalidation bug forever. Copy into local state only for an in-progress edit buffer, and drop it on save.
- Derive, do not duplicate. If a value is computable from existing state or props, compute it during render rather than storing it in a second state variable that can drift.

## Data fetching

- **Route network access through a typed client, not scattered `fetch` calls.** `target:` fonto has not extracted one yet — today client components call `fetch` against `/api/v1/*` and uploads go through `lib/upload-client.ts`. When calls to an endpoint repeat, extract the shared client rather than adding another raw `fetch`: a wrapper is where base URL, auth headers, error shaping, and response typing belong, and a raw call opts out of all of them silently.
- If an endpoint's response type is missing or wrong, fix it in the shared types — do not cast at the call site. A local cast makes the next caller repeat the bug.
- **Avoid request waterfalls.** Requests that do not depend on each other are issued in parallel, not sequentially awaited. A child component that fetches data its parent could have requested alongside its own turns one round-trip into two.
- Fetch at the route/page level or in a dedicated hook — not inside deeply nested presentational components, which makes the request count a function of the render tree.
- Mutations invalidate or update the affected cache entries. A stale list after a successful create is a bug, not a refresh-button opportunity.

## Loading, empty, and error — the required trio

Every asynchronous surface ships all three states. No exceptions, and this is checkable in review by looking for the three branches.

- **Loading** — a skeleton or inline indicator matching the eventual layout, so content does not shift when data lands.
- **Empty** — a real designed state that names what belongs here and offers the action that creates it. A blank region reads as a broken page.
- **Error** — a visible message in the UI *and* a logged error with enough context to debug. **Never let a user-facing async operation fail silently**; a spinner that never resolves is the worst possible outcome because the user cannot tell whether to wait or retry. Error shape and logging rules live in `error-handling.md`.

This applies to page loads, form submissions, background saves, file uploads, and auth flows alike.

## Accessibility floor

Non-negotiable minimum; a screen failing any of these is not done:

- **Every interactive element is reachable and operable by keyboard.** If you attach a click handler to a non-interactive element, you have created a control that keyboard and screen-reader users cannot use — use a real button/link instead.
- **Focus is always visible.** Never remove the focus outline without replacing it with an equally clear one, and return focus sensibly when dialogs and menus close.
- **Every control has an accessible name** — a visible label tied to the input, or an explicit label attribute for icon-only buttons. An icon alone is unlabelled.
- **Contrast meets WCAG AA** (4.5:1 body text, 3:1 large text and interactive boundaries). Muted-on-muted is the usual offender.
- **Never encode meaning in color alone** — pair status color with text or an icon.
- **Respect reduced-motion preferences**: disable non-essential animation when the user has asked for it at the OS level.
- Images carry meaningful alt text, or empty alt when purely decorative.

## Performance hygiene

- **Virtualize long lists.** Render-everything is fine up to roughly a few hundred rows; past that, virtualize or paginate — beyond that threshold the DOM node count, not your code, becomes the bottleneck.
- **Give every image explicit dimensions** and serve it at display size. Unsized images cause layout shift; oversized ones waste the user's bandwidth on pixels never shown.
- Memoize only in response to a measured problem. Speculative memoization adds dependency arrays that go stale and produce bugs far more expensive than the render it saved.
- Code-split at route boundaries so a rarely used screen does not sit in the initial bundle.
- Keep effects narrowly scoped with honest dependencies. An over-broad effect that refetches on every render is the most common self-inflicted performance bug in client code.

## Removing UI

Deleting a button is never the whole change. When you remove the last entry point into a view, route, modal, or state branch, remove what it reached: the route registration, the view component, its state variant, its data fetching, and its tests — in the same change. Search the repo (including string-keyed and dynamic references) to confirm it was the last caller. An unreachable screen still ships in the bundle, still breaks silently, and still costs the next reader time. See `code-style.md` for the general dead-code rule.

