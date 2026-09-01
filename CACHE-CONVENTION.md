# Fonto cache convention (T1.3)

Reference: [`docs/claude/platform/completed/perf-audit/perf-audit-plan.md`](./docs/claude/platform/completed/perf-audit/perf-audit-plan.md) §T1.3 — per-route cache audit.

This doc captures the convention every `/api/v1/*/route.ts` handler should follow when deciding whether to mark itself `force-dynamic`, opt-in to `revalidate`, or wrap a query in `unstable_cache` + tag-based invalidation.

## 7-class taxonomy

| Class | Description | Example routes | Cache policy |
|---|---|---|---|
| **A. Per-user cursored / mutable** | Lists keyed by a per-request cursor, per-user activity, or a mint that must never be served twice. Caching has no win. | `/api/v1/assets`, `/api/v1/assets/buckets`, `/api/v1/sync/delta`, presigned-url mints, recent-activity feeds. | **KEEP** `export const dynamic = "force-dynamic"`. |
| **B. Workspace-scoped read catalogue** | Small, slowly-changing list of rows owned by one workspace (or the caller's workspace set). Same response for everyone in the workspace until a mutation lands. | `/api/v1/tags`, `/api/v1/collections`, `/api/v1/persons`, `/api/v1/shoots`, `/api/v1/smart-collections`, `/api/v1/folders/tree`, `/api/v1/clients`, `/api/v1/correspondents`, `/api/v1/document-types`, `/api/v1/projects`, `/api/v1/person-groups`. | **DROP** `force-dynamic`. Add `export const revalidate = 300` (5 min safety) + wrap the query in `unstable_cache` keyed by workspaceId (or sorted workspaceId list) and tagged `ws:<workspaceId>:<resource>`. The matching mutation routes (class E) must call `revalidateTag` so writes evict immediately. |
| **C. Per-asset detail** | One-row read keyed by a specific asset / share / face / smart-collection id. Cardinality is high (millions of rows) and hit-rate per key is low. | `/api/v1/assets/[id]/url`, `/api/v1/assets/[id]/faces`, `/api/v1/assets/[id]/tags` (LIST), `/api/v1/assets/[id]/share`, `/api/v1/smart-collections/[id]`. | **KEEP** `force-dynamic` for now. |
| **D. Search** | Hot read but parameterised by free-text / vector query — caching belongs in the dedicated Valkey layer (T2.1), not on the Next route. | `/api/v1/search`, `/api/v1/search/clip`. | **KEEP** `force-dynamic`. The T2.1 Valkey cache (separate task) covers this. |
| **E. Mutating routes (POST/PATCH/DELETE)** | Any handler that writes to a class-B-backed table (or detaches rows from one). | `/api/v1/tags` POST, `/api/v1/clients` POST/PATCH/DELETE, `/api/v1/projects/[id]` DELETE (detaches collections), `/api/v1/smart-collections/[id]` PATCH/DELETE, uploads/complete, etc. | **KEEP** `force-dynamic` AND on success call `revalidateTag(\`ws:${workspaceId}:<resource>\`, "max")` for every catalogue the write affects. A cross-table write (e.g. project DELETE → collections detach) invalidates BOTH tags. |
| **F. Global static** | Pure static payload — no per-user / per-workspace input. | `/api/v1/openapi.json`, `.well-known/*`. | Already cacheable (Next will static-generate). Verify; don't touch. |
| **G. Webhooks / health** | Side-effecting endpoints called by external systems or monitors. Must never be cached. | `/api/v1/webhooks/*`, `/api/health`, `/api/metrics`. | **KEEP** `force-dynamic`. |

## The `ws:<workspaceId>:<resource>` tag scheme

Every class-B route tags its cached payload with one tag per workspace whose rows it contains. The resource segment is the catalogue table name in `snake_case`:

| Catalogue | Tag |
|---|---|
| `tags` | `ws:${workspaceId}:tags` |
| `collections` | `ws:${workspaceId}:collections` |
| `smart_collections` | `ws:${workspaceId}:smart_collections` |
| `persons` | `ws:${workspaceId}:persons` |
| `person_groups` | `ws:${workspaceId}:person_groups` |
| `shoots` | `ws:${workspaceId}:shoots` |
| `clients` | `ws:${workspaceId}:clients` |
| `projects` | `ws:${workspaceId}:projects` |
| `correspondents` | `ws:${workspaceId}:correspondents` |
| `document_types` | `ws:${workspaceId}:document_types` |
| `folders` (the tree) | `ws:${workspaceId}:folders` |

A multi-workspace GET (e.g. `/api/v1/tags` over `getUserWorkspaces`) must tag with **every** workspace id in the result so that a write in workspace `A` evicts any cached row that included `A` even if the cache key was the (sorted) set `{A,B}`.

## When to use which

```
              ┌─────────────────────────┐
              │  Does the response      │
              │  vary per user beyond   │
              │  workspace membership?  │
              └───────┬───────────┬─────┘
                  yes │           │ no
                ┌─────┘           └─────┐
                ▼                       ▼
       force-dynamic            ┌───────────────┐
       (class A/C/D/E/G)        │  Is it tiny + │
                                │  catalogue-y? │
                                └─┬───────────┬─┘
                              yes │           │ no
                                  ▼           ▼
                        unstable_cache    force-dynamic
                          + tags          (class C if
                        (class B,         per-asset, F
                         revalidate=300)  if static)
```

Rules of thumb:

- `force-dynamic` = "always re-execute this on every request" — pick when the response depends on per-request state (cursor, auth token, system clock) or has side effects.
- `revalidate = N` = "if the SAME inputs hit this within N seconds, serve last response" — the safety net for class-B reads. Without `unstable_cache` this only helps streaming/route-segment cache; pair with `unstable_cache` to get real wins.
- `unstable_cache(fn, key, { tags })` = the actual catalogue cache. Key MUST include `workspaceId` (or sorted workspaceId list) so tenants don't share rows. Tags MUST include `ws:<workspaceId>:<resource>` for every workspace in the result so mutations evict.

## One example per class

### Class A — `/api/v1/assets`
```ts
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  // cursor-based per-user list — no caching value
  ...
}
```

### Class B — `/api/v1/clients`
```ts
export const revalidate = 300;
import { unstable_cache, revalidateTag } from "next/cache";

const loadClients = (workspaceId: string) =>
  unstable_cache(
    async () =>
      db.select().from(schema.clients)
        .where(eq(schema.clients.workspaceId, workspaceId))
        .orderBy(schema.clients.name),
    ["clients-list", workspaceId],
    { tags: [`ws:${workspaceId}:clients`], revalidate: 300 }
  )();

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ clients: [] });
  return NextResponse.json({ clients: await loadClients(workspaces[0].id) });
}
```

### Class C — `/api/v1/assets/[id]/url`
```ts
export const dynamic = "force-dynamic";
// per-asset, high cardinality, low cache value
```

### Class D — `/api/v1/search`
```ts
export const dynamic = "force-dynamic";
// caching belongs in the dedicated Valkey layer (T2.1)
```

### Class E — `/api/v1/clients` POST/PATCH/DELETE
```ts
export async function POST(request: NextRequest) {
  // ... validate, write ...
  const [client] = await db.insert(schema.clients).values({...}).returning();
  revalidateTag(`ws:${workspaceId}:clients`, "max");   // <- the rule (Next 16 requires the "max" profile arg)
  return NextResponse.json({ client }, { status: 201 });
}
```

Cross-table mutations invalidate every affected catalogue:

```ts
// /api/v1/projects/[id] DELETE — also detaches collections
revalidateTag(`ws:${workspaceId}:projects`, "max");
revalidateTag(`ws:${workspaceId}:collections`, "max");
```

### Class F — `/api/v1/openapi.json`
```ts
// No force-dynamic, no revalidate — Next will static-generate the route.
export async function GET() { return NextResponse.json(spec); }
```

### Class G — `/api/v1/webhooks/[id]/deliveries`
```ts
export const dynamic = "force-dynamic";
// receives state from an external sender; never cache.
```

## The mutation → invalidate rule

> Every class-E handler MUST, on every success path, call `revalidateTag` for every catalogue tag whose underlying rows it touched.

If a write affects N catalogues, that's N `revalidateTag` calls. They are idempotent and cheap; missing one is a stale-read bug that is invisible in dev (because everything is `force-dynamic` in dev mode) and only surfaces under prod cache hits.

Examples already wired (T1.3):

- `/api/v1/clients` POST/PATCH/DELETE → `ws:<id>:clients`
- `/api/v1/collections` POST → `ws:<id>:collections`
- `/api/v1/smart-collections` POST → `ws:<id>:smart_collections`
- `/api/v1/smart-collections/[id]` PATCH/DELETE → `ws:<id>:smart_collections`
- `/api/v1/correspondents` POST/DELETE → `ws:<id>:correspondents`
- `/api/v1/document-types` POST/DELETE → `ws:<id>:document_types`
- `/api/v1/projects` POST → `ws:<id>:projects`
- `/api/v1/projects/[id]` PATCH → `ws:<id>:projects`
- `/api/v1/projects/[id]` DELETE → `ws:<id>:projects` AND `ws:<id>:collections`
- `/api/v1/person-groups` POST → `ws:<id>:person_groups`
- `/api/v1/person-groups/[id]` PATCH/DELETE → `ws:<id>:person_groups`
- `/api/v1/tags` POST → `ws:<id>:tags`

## Interaction with the Valkey overlay (T2.2)

Routes that ALSO have a Valkey-layer cache (`@/lib/cache/valkey`) — currently `/api/v1/tags`, `/api/v1/collections`, `/api/v1/smart-collections` — call BOTH:

```ts
revalidateTag(`ws:${workspaceId}:tags`, "max");   // Next-cache, per-pod
void cacheInvalidate(`ws:${workspaceId}:tags`);  // Valkey, cross-pod
```

The Valkey overlay handles cross-instance cache sharing and the stampede lock; the Next `unstable_cache` is the per-pod in-process tier that sits in front. Both must be invalidated on writes.

## Ambiguous routes deferred from T1.3

These look like class-B catalogues at first glance but embed aggregated counts from `fonto.assets`. Caching them safely requires every asset-side CRUD (`/api/v1/assets/*`, uploads, scope reassign, folder ops, bulk imports, face moves) to also `revalidateTag(...)` — a much wider blast radius than this task's scope. They remain `force-dynamic` until a follow-up task wires the asset-side invalidation:

- `/api/v1/shoots` (embeds per-shoot asset counts grouped by stage)
- `/api/v1/places` (aggregates `place_name` over assets)
- `/api/v1/folders/tree` (counts assets per `directory_path`)
- `/api/v1/persons` (`instance_count` maintained by face-instance flows)
- `/api/v1/tags/top` (counts `asset_tags` rows)
- `/api/v1/collections/stats`, `/api/v1/collections/[id]/assets` (embed asset counts)

## Hard rules

1. NEVER cache `getAuthUser()` output inside the `unstable_cache` closure — only the DB query. The closure is keyed by workspaceId, not user, and tenants share workspaces.
2. NEVER cache anything that varies by `Authorization` header, cookies, or per-request body content (i.e. anything more granular than workspace).
3. ALWAYS include EVERY workspace id from the result in the tag list when the response spans multiple workspaces (e.g. `getUserWorkspaces`). Missing a tag = stale row after a write in that workspace.
4. ALWAYS call `revalidateTag` BEFORE returning the response from a mutation. Calling it after the response has been sent races against the next read.
5. If a route is ambiguous (embeds asset counts, depends on per-user filters, etc.), default to `force-dynamic` and add a note here.

---

Owner: this convention is part of the perf-audit follow-through. Updates should reference both this file and `docs/claude/platform/completed/perf-audit/perf-audit-plan.md` so the two stay in sync.
