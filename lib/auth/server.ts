// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import type { User } from "./types";

export async function getAuthUser(): Promise<User | null> {
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) return null;
    return session.user as User;
  } catch {
    return null;
  }
}
