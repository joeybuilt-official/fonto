# Clean Architecture

> Applies to every new code change. Dependencies point inward; framework, storage, queue, UI, and vendor code stays at the edge.

## The premise

Business rules should survive changes to Next.js, Drizzle, Postgres, R2, BullMQ, Flutter, and Plexo. Keep rules in plain modules where possible. Put I/O behind a port when a use case needs it, and compose concrete adapters at the edge.

## Fonto target map

This is an adopt-as-target map, not a claim that the existing repository is fully layered. The paths are the nearest existing roles; current gaps are recorded in `docs/claude/architecture.md`.

| Layer | Directory in Fonto | Rule |
| --- | --- | --- |
| Entities / Domain | `lib/fusion/` | Pure evidence/date rules only. No database, HTTP, queue, storage, env, or vendor imports. |
| Use Cases / Application | `lib/processing/` | Asset-processing operations and ports. New operations should not accept Drizzle rows, `NextRequest`, or queue payloads as domain inputs. |
| Interface Adapters | `app/api/` | Route handlers translate transport input/output and enforce authz; `lib/openapi/` owns published route contracts. |
| Frameworks & Drivers | `lib/db/` | Drizzle schema/client. Other drivers include `lib/storage/`, `lib/queue/`, `worker/`, `ops/`, and the Next.js/Flutter edges. |

## Placement test

1. Changes because a Fonto business rule changed: `lib/fusion/` or a pure feature module.
2. Orchestrates one application operation: `lib/processing/` or the owning feature module.
3. Translates HTTP, storage, queue, UI, or vendor shapes: an adapter at `app/api/`, `lib/`, `worker/`, or the client edge.
4. Changes because a framework, driver, or vendor changed: Frameworks & Drivers.

If a file answers both questions, split the rule from the integration before expanding it.

## Boundary rules

- Route handlers parse and authorize, call inward logic, then map the result. Do not put new business decisions in `app/api/`.
- Do not pass Drizzle rows, ORM query builders, `NextRequest`, `NextResponse`, or queue job payloads into pure rules.
- DTOs cross HTTP and process boundaries. Do not serialize a domain object directly as a public response.
- Validate shape and format at the adapter; enforce invariants again in entities/use cases so jobs, CLI calls, and tests cannot bypass them.
- Declare an interface inward when the core needs database, clock, random ID, filesystem, queue, or HTTP access. Implement it outward.
- A port needs a real implementation and a test double, or a documented reason not to add one.

## Review checklist

- New code under `lib/fusion/` has no outer imports.
- New use-case code does not import `drizzle-orm`, Next.js, storage, queue, or vendor SDKs.
- Every `/api/v1` handler validates input, checks workspace authorization, calls inward logic, and returns the documented envelope.
- Persistence stays behind `lib/db/`; object storage stays behind `lib/storage/`; queue wiring stays behind `lib/queue/` and `worker/`.
- A vendor swap would not require editing `lib/fusion/` or the use-case contract.
