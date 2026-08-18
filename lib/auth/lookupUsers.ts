// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Resolve better-auth user ids to display info. The auth user table lives in
// a separate schema managed by better-auth, so it's read through the adapter
// rather than a drizzle join. Shared by the daily digest and the activity feed
// so actor ids render as names/emails instead of raw uuids.

import { auth } from "@/lib/auth";
import type { User } from "@/lib/auth/types";
import { logger } from "@/lib/logger";

export async function loadUsersByIds(
  userIds: string[]
): Promise<Map<string, User>> {
  const out = new Map<string, User>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return out;
  try {
    const ctx = await auth.$context;
    for (const id of unique) {
      const row = await ctx.adapter.findOne<Record<string, unknown>>({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (row) out.set(id, row as unknown as User);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "auth.user_lookup_failed"
    );
  }
  return out;
}

export function userDisplayName(
  user: User | undefined,
  fallbackId: string
): string {
  if (!user) return fallbackId;
  const name = (user as { name?: string | null }).name;
  if (typeof name === "string" && name.trim().length > 0) return name;
  const email = (user as { email?: string | null }).email;
  if (typeof email === "string") {
    const local = email.split("@")[0];
    if (local) return local;
  }
  return fallbackId;
}

export function userEmail(user: User | undefined): string | null {
  const email = (user as { email?: string | null } | undefined)?.email;
  return typeof email === "string" && email.length > 0 ? email : null;
}
