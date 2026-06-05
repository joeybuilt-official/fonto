// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { betterAuth } from "better-auth";
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.AUTH_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://placeholder:5432/placeholder",
  max: 10,
  idleTimeoutMillis: 30_000,
  options: "-c search_path=auth",
});

export const auth = betterAuth({
  database: pool,
  emailAndPassword: {
    enabled: true,
  },
  // better-auth's built-in rate limiter defaults to a very tight per-path
  // budget for sensitive endpoints — a user who mistypes their password a
  // couple times (or whose page just fires a few /get-session calls) trips a
  // 429, which the client surfaces as the generic "Something went wrong".
  // Raise the sign-in/up budget to a humane level that still blunts
  // brute-force (10 attempts / minute).
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
    },
  },
  trustedOrigins: [
    process.env.BETTER_AUTH_URL,
    "https://myfonto.com",
  ].filter((url): url is string => !!url),
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
