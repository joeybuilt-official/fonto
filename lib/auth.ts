// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { Pool } from "pg";
import { sendPasswordResetEmail } from "@/lib/invitations/email";
import { hasPendingInvitationForEmail } from "@/lib/invitations/core";

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

// Invite-only registration (owner-approved policy). Open self-signup is
// disabled by default: a new user may only register if (a) the deploy opts
// back into open signup via FONTO_ALLOW_OPEN_SIGNUP=true, (b) they are the
// very first user on the instance (bootstrap owner), or (c) their email has a
// pending workspace invitation — the legitimate funnel (app/invitations). The
// invitation-accept path is unaffected: an invited user's email matches a
// pending invitation, so the gate lets them through.
async function assertSignupAllowed(email: string): Promise<void> {
  if (process.env.FONTO_ALLOW_OPEN_SIGNUP === "true") return;

  // Bootstrap: the first-ever user (instance owner) has no invitation. The
  // Better Auth user table lives in the `auth` schema (pool search_path).
  const existing = await pool.query('SELECT 1 FROM "user" LIMIT 1');
  if (existing.rows.length === 0) return;

  if (email && (await hasPendingInvitationForEmail(email))) return;

  throw new APIError("FORBIDDEN", {
    message:
      "Registration is invite-only. Ask a workspace owner to invite you.",
  });
}

export const auth = betterAuth({
  database: pool,
  emailAndPassword: {
    enabled: true,
    // M-daily-driver — password reset. Better Auth builds the reset URL and
    // hands it here; we deliver it via the shared transactional-email sender
    // (lib/invitations/email.ts → Resend). Runs in the background, so an
    // unconfigured/misfiring transport is logged, never surfaced to the
    // requester (avoids leaking which addresses are registered).
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, resetUrl: url });
    },
  },
  // M-daily-driver — allow editing the account email from Settings. Emails in
  // this app are never verified (no email-verification flow is wired), so
  // updateEmailWithoutVerification lets an unverified address change directly.
  user: {
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true,
    },
  },
  // M-daily-driver — invite-only registration gate. `create.before` runs
  // inside the sign-up flow; throwing an APIError aborts it with a 403 the
  // client surfaces as the form error. Password/passkey/one-time-link sign-in
  // never creates a user, so only genuine registrations hit this.
  databaseHooks: {
    user: {
      create: {
        before: async (userData: { email?: string }) => {
          await assertSignupAllowed((userData.email ?? "").trim());
        },
      },
    },
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
  // Trusted origins are CONFIGURED, never hardcoded: this repo is public, so a
  // baked production hostname here would both leak infrastructure and, worse,
  // make every self-hosted deploy trust an origin it does not control. Better
  // Auth always trusts its own `baseURL`, so setting BETTER_AUTH_URL is
  // sufficient for the normal single-origin case.
  trustedOrigins: [
    process.env.BETTER_AUTH_URL,
    process.env.OIDC_REDIRECT_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    // Comma-separated extras for multi-origin deploys (e.g. a separate
    // marketing apex redirecting into the app origin).
    ...(process.env.EXTRA_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
