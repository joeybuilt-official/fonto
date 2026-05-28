// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Playwright config for Library chip-strip + back-button E2E.
//
// Target: the live deployment on the host (http://127.0.0.1:3500).
// Auth: stored in e2e/.auth/user.json — generate with `npx playwright test --setup`.
//
// Usage (from /workspace/fonto):
//   npx playwright install chromium --with-deps
//   BASE_URL=http://127.0.0.1:3500 npx playwright test

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3500";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: {
        // Use system Chromium (the bundled one doesn't support ubuntu26.04)
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? "/usr/bin/chromium",
        },
      },
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? "/usr/bin/chromium",
        },
      },
      dependencies: ["setup"],
    },
  ],
});
