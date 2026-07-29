// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Playwright auth setup — logs in once and saves storage state so
// the main test projects reuse the session.
//
// Set env vars before running:
//   PLAYWRIGHT_EMAIL=you@example.com PLAYWRIGHT_PASSWORD=yourpass \
//   BASE_URL=http://127.0.0.1:3500 npx playwright test

import { test as setup, expect } from "@playwright/test";
import path from "path";

const authFile = path.join(__dirname, ".auth/user.json");

setup("authenticate", async ({ page }) => {
  const email = process.env.PLAYWRIGHT_EMAIL;
  const password = process.env.PLAYWRIGHT_PASSWORD;
  if (!email || !password) {
    throw new Error("PLAYWRIGHT_EMAIL and PLAYWRIGHT_PASSWORD must be set");
  }

  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();

  // After login, redirects to /app/home
  await expect(page).toHaveURL(/\/app\//, { timeout: 10_000 });

  await page.context().storageState({ path: authFile });
});
