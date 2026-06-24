// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { Pool } from "pg";

// M14 / ADR 0056 — OIDC/SSO, additive to email+password. Dormant until the
// operator wires an IdP: with OIDC_* unset, `oidcProviders()` returns [], the
// genericOAuth plugin is not mounted, and auth behaviour is byte-identical to
// today (email+password only). Redirect URI to register at the IdP:
//   https://<host>/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>
function oidcProviders() {
  const { OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_DISCOVERY_URL } = process.env;
  if (!OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_DISCOVERY_URL) return [];
  return [
    {
      providerId: process.env.OIDC_PROVIDER_ID ?? "sso",
      clientId: OIDC_CLIENT_ID,
      clientSecret: OIDC_CLIENT_SECRET,
      discoveryUrl: OIDC_DISCOVERY_URL,
      scopes: (process.env.OIDC_SCOPES ?? "openid profile email").split(" "),
      pkce: true,
    },
  ];
}
const _oidcProviders = oidcProviders();

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
    process.env.OIDC_REDIRECT_BASE_URL,
    "https://myfonto.com",
  ].filter((url): url is string => !!url),
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  // M14 / ADR 0056 — only mount genericOAuth + cross-provider account linking
  // when an IdP is actually configured; otherwise this is an empty array and
  // email+password is the sole path (unchanged behaviour).
  plugins: _oidcProviders.length ? [genericOAuth({ config: _oidcProviders })] : [],
  account: _oidcProviders.length
    ? {
        accountLinking: {
          enabled: true,
          trustedProviders: _oidcProviders.map((p) => p.providerId),
        },
      }
    : undefined,
});
