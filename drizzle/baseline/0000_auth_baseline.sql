-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- 0000 — BETTER-AUTH (`auth` schema) BASELINE.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `lib/auth.ts` opens its Pool with `options: "-c search_path=auth"`, so all
-- Better Auth tables (user / session / account / verification) live in a
-- Postgres schema named `auth` — NOT in `fonto`, and NOT in `public`.
--
-- Nothing in the repo ever created that schema. Better Auth's own migrator
-- (`auth.$init()` / `getMigrations`) is never called anywhere in the tree, and
-- `drizzle/migrations/` only ever touches `fonto.*`. So on a fresh database
-- every Better Auth query fails with `relation "user" does not exist`, and
-- signup/login are dead — the README quick start could not have worked.
--
-- The DDL below was generated from the INSTALLED better-auth version, not
-- hand-written, so it matches what the library itself would emit:
--
--     import { getMigrations } from "better-auth/db/migration";
--     const { compileMigrations } = await getMigrations(auth.options);
--
-- with `auth` configured exactly as `lib/auth.ts` does (emailAndPassword
-- enabled, genericOAuth plugin dormant until OIDC_* is set — it adds no
-- tables). Postgres-specific adjustments from the generated output:
--   * every object schema-qualified with `auth.` (better-auth relies on
--     search_path; qualifying is equivalent and explicit)
--   * CREATE TABLE / CREATE INDEX → IF NOT EXISTS for idempotency
--   * `CURRENT_TIMESTAMP` defaults kept verbatim
--
-- Field naming is camelCase, quoted — that is better-auth's own convention and
-- what its queries emit. Do NOT "fix" it to snake_case.
--
-- Regenerating: if you upgrade better-auth and it adds a field, re-run the
-- generator above and diff. Keep the version comment in sync.

CREATE SCHEMA IF NOT EXISTS auth;

-- order 1
CREATE TABLE IF NOT EXISTS auth."user" (
  "id"            text NOT NULL PRIMARY KEY,
  "name"          text NOT NULL,
  "email"         text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image"         text,
  "createdAt"     timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"     timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- order 2
CREATE TABLE IF NOT EXISTS auth."session" (
  "id"         text NOT NULL PRIMARY KEY,
  "expiresAt"  timestamptz NOT NULL,
  "token"      text NOT NULL UNIQUE,
  "createdAt"  timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"  timestamptz NOT NULL,
  "ipAddress"  text,
  "userAgent"  text,
  "userId"     text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON auth."session" ("userId");

-- order 3
CREATE TABLE IF NOT EXISTS auth."account" (
  "id"                     text NOT NULL PRIMARY KEY,
  "accountId"              text NOT NULL,
  "providerId"             text NOT NULL,
  "userId"                 text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  "scope"                  text,
  "password"               text,
  "createdAt"              timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"              timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON auth."account" ("userId");

-- order 4
CREATE TABLE IF NOT EXISTS auth."verification" (
  "id"         text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"  timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON auth."verification" ("identifier");
