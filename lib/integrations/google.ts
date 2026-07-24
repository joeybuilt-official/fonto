// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — Google OAuth helpers.
//
// Server-side OAuth for Google Drive (readonly) so a later phase can stream
// Takeout archives out of the user's Drive. This module owns:
//   - building the consent-screen URL (offline access → refresh token),
//   - minting a live access token from a stored, encrypted refresh token, and
//   - the `invalid_grant` → `needs_reconnect` transition (revoked token, or a
//     7-day Testing-app refresh-token expiry — see ADR 0001 C1).
//
// Env vars (flag for the deploy .env):
//   - GOOGLE_OAUTH_CLIENT_ID
//   - GOOGLE_OAUTH_CLIENT_SECRET
//   - NEXT_PUBLIC_APP_URL (optional; the OAuth redirect base — defaults to the
//     production origin below, which is the URI registered with Google).

import { google } from "googleapis";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "./tokenCrypto";

/**
 * Registered redirect URI (must match the Google Cloud console exactly). The
 * base origin is configurable via NEXT_PUBLIC_APP_URL so non-prod environments
 * can point at their own callback; it defaults to the production origin, which
 * is the URI registered with Google.
 */
export const GOOGLE_REDIRECT_URI = `${
  (process.env.NEXT_PUBLIC_APP_URL ?? "https://myfonto.com").replace(/\/+$/, "")
}/api/v1/integrations/google/callback`;

/**
 * Requested OAuth scopes (least-privilege, read-only):
 *   - drive.readonly                     → Takeout archives + Drive importer.
 *   - photospicker.mediaitems.readonly   → Google Photos Picker API: read the
 *     media items the user explicitly picks in Google's own picker session.
 *
 * NOTE: existing connections were granted drive.readonly only — they must
 * re-consent (reconnect) to gain the Photos Picker scope; a stored refresh
 * token minted before this change will NOT carry it.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
];

/** Row shape this module needs from the `integrations` table. */
type IntegrationRow = typeof schema.integrations.$inferSelect;

/**
 * Thrown when a refresh attempt comes back `invalid_grant` — the refresh token
 * is no longer valid (user revoked, or Testing-app 7-day expiry). The caller
 * should surface a reconnect CTA. The integration row is flipped to
 * `needs_reconnect` before this is thrown.
 */
export class ReconnectRequiredError extends Error {
  constructor(public readonly integrationId: string) {
    super(`Google integration ${integrationId} needs reconnect (invalid_grant)`);
    this.name = "ReconnectRequiredError";
  }
}

function requireOAuthEnv(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set"
    );
  }
  return { clientId, clientSecret };
}

/**
 * Construct a fresh OAuth2 client bound to our credentials + redirect URI.
 * One per request — the googleapis client is stateful (it caches tokens), so
 * we never share an instance across users.
 */
export function buildOAuthClient() {
  const { clientId, clientSecret } = requireOAuthEnv();
  return new google.auth.OAuth2(clientId, clientSecret, GOOGLE_REDIRECT_URI);
}

/**
 * Build the Google consent-screen URL. `state` is an opaque, signed value the
 * callback validates (ties the round-trip to the initiating user+workspace).
 *
 *   - access_type: 'offline'  → Google issues a refresh token.
 *   - prompt: 'consent'       → force the consent screen so we reliably get a
 *                               refresh token even on re-connect (Google omits
 *                               it on silent re-auth otherwise).
 */
export function buildConsentUrl(state: string): string {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

/**
 * Exchange an authorization `code` (from the callback) for tokens. Returns the
 * raw token set; the caller is responsible for encrypting + persisting the
 * refresh token. Surfaces `refresh_token`, `scope`, `access_token`.
 */
export async function exchangeCode(code: string): Promise<{
  refreshToken: string | null;
  accessToken: string | null;
  scope: string | null;
}> {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  return {
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token ?? null,
    scope: tokens.scope ?? null,
  };
}

/**
 * Exchange a `serverAuthCode` minted by the mobile google_sign_in offline-access
 * flow for tokens. Mobile can't use the web browser-redirect consent flow, so it
 * requests offline access (serverClientId + drive.readonly) on-device; Google
 * returns a one-time server auth code which the app POSTs to
 * /api/v1/integrations/google/mobile-connect, and we redeem it here.
 *
 * Unlike `exchangeCode` (web redirect flow), the auth code from a native client
 * is NOT tied to our web redirect URI, so we redeem it with redirect_uri unset.
 * The result shape matches `exchangeCode` so the route can reuse the same
 * encrypt-and-upsert path as the web callback.
 */
export async function exchangeServerAuthCode(code: string): Promise<{
  refreshToken: string | null;
  accessToken: string | null;
  scope: string | null;
}> {
  const { clientId, clientSecret } = requireOAuthEnv();
  // No redirect URI: a native serverAuthCode is redeemed against the OAuth
  // client directly (the on-device flow already established user consent).
  const client = new google.auth.OAuth2(clientId, clientSecret);
  const { tokens } = await client.getToken(code);
  return {
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token ?? null,
    scope: tokens.scope ?? null,
  };
}

/**
 * Decrypt the stored refresh token, refresh it, and return a live access
 * token. On `invalid_grant`, flips the row to `needs_reconnect` and throws
 * `ReconnectRequiredError`.
 *
 * Phase 2 calls this before each Drive operation (access tokens are short —
 * ~1h — so refresh-per-use is simplest and correct; googleapis will reuse a
 * still-valid token internally if you keep the client around for a batch).
 */
export async function getFreshAccessToken(integration: IntegrationRow): Promise<string> {
  if (!integration.encryptedRefreshToken) {
    throw new ReconnectRequiredError(integration.id);
  }

  const refreshToken = decryptToken(integration.encryptedRefreshToken);
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });

  try {
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error("Google returned an empty access token");
    }
    return token;
  } catch (err: unknown) {
    if (isInvalidGrant(err)) {
      await db
        .update(schema.integrations)
        .set({ status: "needs_reconnect", updatedAt: new Date() })
        .where(eq(schema.integrations.id, integration.id));
      throw new ReconnectRequiredError(integration.id);
    }
    throw err;
  }
}

/**
 * Server-side authed fetch against a Google API. Resolves a live access token
 * via `getFreshAccessToken` (which handles refresh + the invalid_grant →
 * `needs_reconnect` transition), attaches it as a Bearer token, and issues the
 * request. A 401 from Google means the token was rejected mid-flight (e.g.
 * revoked between refresh and use) → flip the row to `needs_reconnect` and
 * throw `ReconnectRequiredError`, matching `getFreshAccessToken`'s contract.
 *
 * The Drive & Photos importers use this for every Google API call so the
 * browser never talks to Google directly. Non-401 non-2xx responses are
 * returned as-is for the caller to inspect (status/body).
 */
export async function googleApiFetch(
  integration: IntegrationRow,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getFreshAccessToken(integration);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    await db
      .update(schema.integrations)
      .set({ status: "needs_reconnect", updatedAt: new Date() })
      .where(eq(schema.integrations.id, integration.id));
    throw new ReconnectRequiredError(integration.id);
  }

  return res;
}

/**
 * Best-effort revoke of a refresh token at Google's revoke endpoint. Does not
 * throw on failure — revocation is advisory; the local row flip to 'revoked'
 * is the source of truth. Returns whether Google acknowledged the revoke.
 */
export async function revokeToken(encryptedRefreshToken: string | null): Promise<boolean> {
  if (!encryptedRefreshToken) return false;
  try {
    const refreshToken = decryptToken(encryptedRefreshToken);
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Detect a Google `invalid_grant` across the several error shapes googleapis
 * surfaces (GaxiosError `.response.data.error`, or an Error message).
 */
function isInvalidGrant(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    response?: { data?: { error?: string } };
    message?: string;
  };
  if (e.response?.data?.error === "invalid_grant") return true;
  if (typeof e.message === "string" && e.message.includes("invalid_grant")) {
    return true;
  }
  return false;
}
