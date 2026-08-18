// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Thin re-export. The implementation moved to `lib/http/parse-json.ts` so
// non-route library code can share the JSON-body guard; this path stays valid
// for the existing v1 route imports (`@/app/api/v1/_lib/parseJson`).
//
// Lives under `_lib/` (an App Router "private folder") so Next.js never treats
// it as a route.
export { parseJson, type ParseJsonResult } from "@/lib/http/parse-json";
