// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Current-user identity probe. Returns the signed-in user's id, name, and
// email so the mobile Settings screen can render the account inline instead
// of only linking out to the browser. Never returns secrets/tokens. 401 when
// anonymous.
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({
    id: user.id,
    name: user.name ?? null,
    email: user.email ?? null,
  });
}
