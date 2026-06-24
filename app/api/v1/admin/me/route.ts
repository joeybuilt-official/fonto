// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — client gating probe. Returns whether the caller is an
// instance admin so the web console + mobile admin tile can show/hide
// themselves. Always 200 for a signed-in user (false when not an admin); 401
// when anonymous.
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { isInstanceAdmin } from "@/lib/authz/instance";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ isInstanceAdmin: isInstanceAdmin(user) });
}
