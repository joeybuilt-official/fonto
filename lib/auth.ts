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
  trustedOrigins: [
    process.env.BETTER_AUTH_URL,
    "https://myfonto.com",
  ].filter((url): url is string => !!url),
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
