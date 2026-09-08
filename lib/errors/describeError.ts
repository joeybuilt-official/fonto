// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
/**
 * One honest, non-empty description for any thrown value.
 *
 * `err instanceof Error ? err.message : String(err)` is the obvious version and
 * it is wrong for a whole class of errors we actually throw. Effect's
 * `Data.TaggedError` subclasses Error but carries its detail in named FIELDS,
 * leaving `message` an empty string — so the obvious version records `''`.
 *
 * That is not hypothetical. On 2026-09-04, 6,704 asset rows sat at
 * `processing_state='failed'` with `processing_error=''`: every one was a
 * `CapabilityUnavailableError({ port, reason })` whose real cause ("no routable
 * completion provider") was thrown away at the point of writing. An empty
 * string is worse than a missing one — `IS NULL` does not find it, so the rows
 * were invisible to the very queries written to explain them.
 *
 * Pure: no imports, no I/O, no framework types. Safe to call from any layer.
 */

/** Error keys that carry no information worth appending to the description. */
const UNINFORMATIVE_KEYS = new Set(["message", "stack", "name", "_tag", "cause"]);

/** Longest a single field value may contribute before it is truncated. */
const MAX_FIELD_LENGTH = 200;

function stringifyFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

/**
 * Named fields on a tagged/structured error, rendered as `key=value`.
 * Only primitives are rendered — a nested object in an error field is almost
 * always a payload we must not paste into a database column or a log line.
 */
function describeFields(err: object): string {
  const parts: string[] = [];
  for (const key of Object.keys(err)) {
    if (UNINFORMATIVE_KEYS.has(key)) continue;
    const rendered = stringifyFieldValue((err as Record<string, unknown>)[key]);
    if (rendered === null) continue;
    parts.push(`${key}=${rendered.slice(0, MAX_FIELD_LENGTH)}`);
  }
  return parts.join("; ");
}

/** Effect's `Data.TaggedError` stamps a string `_tag`; anything else returns null. */
function taggedName(err: object): string | null {
  const tag = (err as { _tag?: unknown })._tag;
  return typeof tag === "string" && tag.length > 0 ? tag : null;
}

/**
 * The most specific name for an Error subclass.
 *
 * `err.name` is INHERITED as the literal "Error" unless a subclass assigns it,
 * so preferring it unconditionally renders `class UnrecoverableError extends
 * Error {}` as plain "Error" and loses the one identifying detail a
 * message-less error has. Take an explicitly-set `name` first, fall back to the
 * constructor, and only then to the generic default.
 */
function errorClassName(err: Error): string {
  if (err.name && err.name !== "Error") return err.name;
  const ctor = err.constructor?.name;
  if (ctor && ctor !== "Object") return ctor;
  return err.name || "Error";
}

/**
 * Describe any thrown value. NEVER returns an empty string — a caller
 * persisting the result can rely on "empty means nothing was thrown".
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    // A real message is always the best description; keep it verbatim so
    // existing log greps and error-class matching keep working.
    if (err.message) return err.message;

    // No message: this is the tagged-error case. Name it by its `_tag` when
    // Effect supplied one, else by its constructor, then append the fields
    // that carry the actual reason.
    const tag = taggedName(err) ?? errorClassName(err);
    const fields = describeFields(err);
    return fields ? `${tag}: ${fields}` : tag;
  }

  if (typeof err === "string") return err.length > 0 ? err : "unknown error";

  if (err && typeof err === "object") {
    const fields = describeFields(err);
    if (fields) {
      const tag = taggedName(err) ?? (err.constructor?.name ?? "object");
      return `${tag}: ${fields}`;
    }
  }

  const coerced = String(err);
  return coerced.length > 0 && coerced !== "[object Object]" ? coerced : "unknown error";
}
