// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Vitest config. Mirrors the `@/*` → `./*` path alias of tsconfig.json so
// colocated route tests (and anything they import) can use the same
// root-relative imports as the handlers they exercise. Fonto intentionally
// pairs every `app/api/v1/**/route.ts` with a colocated `route.test.ts`; those
// handlers import `@/lib/...`, which vitest could not resolve before this
// file existed. Relative-import-only tests are unaffected.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // Exclude scripts/ — those *.test.ts are self-contained tsx harnesses run
    // via `npx tsx`, not vitest suites (see scripts/_scope/*). Worktrees are
    // machine-local harness copies, never part of the repo's suite.
    include: [
      "lib/**/*.test.ts",
      "app/**/route.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "packages/**/*.test.ts",
    ],
    environment: "node",
    // Handler tests mock auth + queue modules; keep them in-process and fast.
    testTimeout: 15_000,
  },
});