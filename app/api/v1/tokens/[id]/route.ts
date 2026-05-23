// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// DELETE /api/v1/tokens/:id — revoke an API key.
// Owner-scoped, session-only (same rationale as POST /api/v1/tokens).
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/server";
import { revokeApiKey } from "@/lib/auth/api-keys";

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ctx.authMethod !== "session") {
    return NextResponse.json(
      { error: "PAT auth cannot revoke tokens — sign in with the web UI" },
      { status: 403 }
    );
  }
  const { id } = await context.params;
  const ok = await revokeApiKey(ctx.user.id, id);
  if (!ok) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
