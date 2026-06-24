// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance-admin authz tier.
//
// An instance admin sits ABOVE workspace ownership: they can see + manage every
// workspace and user on the appliance (server stats, user list/disable, quota).
// Identity is an env allowlist (`FONTO_INSTANCE_ADMINS`, comma-separated
// emails) — zero schema, zero migration, reversible by editing env + restart.
// Unset/empty ⇒ ZERO admins (fail-closed by design): the tier simply doesn't
// exist until the operator opts in.
//
// This is deliberately NOT a DB column: an env allowlist has no bootstrap-
// first-admin problem and no lock-everyone-out risk.

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import type { User } from "@/lib/auth/types";

let _admins: Set<string> | null = null;

/** Memoized lowercase email allowlist from FONTO_INSTANCE_ADMINS. */
function adminEmails(): Set<string> {
  if (_admins) return _admins;
  _admins = new Set(
    (process.env.FONTO_INSTANCE_ADMINS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
  return _admins;
}

/** True when `user`'s email is in the instance-admin allowlist. */
export function isInstanceAdmin(user: Pick<User, "email"> | null | undefined): boolean {
  const email = user?.email;
  if (!email) return false;
  return adminEmails().has(email.toLowerCase());
}

export type InstanceAdminResult =
  | { ok: true; user: User }
  | { ok: false; response: NextResponse };

/**
 * Route guard: resolve the session, 401 if anonymous, 403 if not an instance
 * admin. Each `app/api/v1/admin/*` handler starts with one call to this.
 */
export async function requireInstanceAdmin(): Promise<InstanceAdminResult> {
  const user = await getAuthUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!isInstanceAdmin(user)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, user };
}
