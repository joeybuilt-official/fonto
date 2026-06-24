// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";

const _authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "",
  // M14 / ADR 0056 — enables `signIn.oauth2`. Harmless when no IdP is wired
  // (the SSO button is hidden, so it's never invoked).
  plugins: [genericOAuthClient()],
});

// M14 / ADR 0056 — the configured SSO provider id, mirrored to the client via a
// public env so the login page can show/hide the SSO button. Empty = no SSO.
export const ssoProviderId = process.env.NEXT_PUBLIC_OIDC_PROVIDER_ID ?? "";

/** Kick off the OIDC sign-in via the system browser / current tab. */
export async function signInSSO(providerId: string, callbackURL: string) {
  return _authClient.signIn.oauth2({ providerId, callbackURL });
}

export function useSession() {
  return _authClient.useSession();
}

export async function signIn(email: string, password: string) {
  return _authClient.signIn.email({ email, password });
}

export async function signUp(email: string, password: string, name: string) {
  return _authClient.signUp.email({ email, password, name });
}

export async function signOut() {
  return _authClient.signOut();
}
