// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos/Files split — Library telemetry.
//
// Thin, dependency-free event sink. There is no analytics provider wired into
// Fonto today, so these are call sites that no-op in production (a dev-only
// console.debug behind the same flag aids local QA). When a sink lands later,
// forward `event`/`props` from this single function — every Library call site
// already routes through it. Payloads carry no PII (query_len, never query
// text).

export type LibraryEvent =
  | "library_surface_toggle" // { from?: string; to: string }
  | "library_surface_view" // { surface: string; dwell_ms: number }
  | "library_lens_select" // { surface: string; lens: string }
  | "library_search" // { surface: string; query_len: number; result_count: number }
  | "library_properties_open"; // { kind: string | null }

export function trackLibrary(
  event: LibraryEvent,
  props: Record<string, string | number | null> = {}
): void {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[telemetry]", event, props);
  }
  // TODO: forward to an analytics sink when one is introduced.
}
