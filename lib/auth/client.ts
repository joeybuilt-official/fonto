// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { createAuthClient } from "better-auth/react";

const _authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "",
});

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
