// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// 8-char base62 slug generator for share links. We collision-check against
// the DB; with 62^8 = 218T possibilities a few re-rolls is fine even at
// millions of links.

import { randomBytes } from "crypto";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function generateSlug(length = 8): string {
  // Reject the top 4 bits worth that would overshoot 62 to keep distribution
  // uniform (rejection sampling).
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const b = bytes[i];
    if (b < 248) out += BASE62[b % 62];
  }
  if (out.length < length) {
    // Pathological — pad with extra random bytes.
    return out + generateSlug(length - out.length);
  }
  return out;
}

export async function generateUniqueSlug(length = 8, maxAttempts = 6): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const slug = generateSlug(length);
    const [hit] = await db
      .select({ id: schema.shareLinks.id })
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.slug, slug))
      .limit(1);
    if (!hit) return slug;
  }
  throw new Error("generateUniqueSlug: exhausted attempts");
}
