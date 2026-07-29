// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// DELETE /api/v1/tokens/:id — revoke an API key.
// Owner-scoped, session-only (same rationale as POST /api/v1/tokens).
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/server";
import { revokeApiKey } from "@/lib/auth/api-keys";
import { recordAuditEvent, AuditAction } from "@/lib/audit";

export async function DELETE(
  req: Request,
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
  void recordAuditEvent({
    workspaceId: null,
    userId: ctx.user.id,
    action: AuditAction.TokenRevoke,
    targetType: "api_key",
    targetId: id,
    request: req,
  });
  return NextResponse.json({ ok: true });
}
