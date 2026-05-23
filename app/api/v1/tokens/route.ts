// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// API key (PAT) management endpoints.
//
// GET  /api/v1/tokens         — list current user's active keys
// POST /api/v1/tokens         — mint a new key (plaintext returned once)
// DELETE /api/v1/tokens/:id   — revoke a key (see ./[id]/route.ts)
//
// All three endpoints are intentionally gated on SESSION AUTH ONLY, not PAT
// auth. Letting a PAT mint more PATs is a known privilege-escalation pattern
// we don't want — physical browser session ownership is the only path to
// new credentials.
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/server";
import {
  createApiKey,
  listApiKeysForUser,
  type ApiKeyScope,
} from "@/lib/auth/api-keys";
import { recordAuditEvent, AuditAction } from "@/lib/audit";

const ScopeEnum = z.enum(["read", "write", "admin"]);

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(ScopeEnum).min(1).max(3),
  // 30 / 90 / 365 / null (never). We accept any positive integer for
  // flexibility; the UI offers the canonical buckets.
  expiresInDays: z.number().int().positive().nullable().optional(),
});

export async function GET() {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ctx.authMethod !== "session") {
    return NextResponse.json(
      { error: "PAT auth cannot manage tokens — sign in with the web UI" },
      { status: 403 }
    );
  }
  const keys = await listApiKeysForUser(ctx.user.id);
  return NextResponse.json({
    tokens: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      firstFour: k.firstFour,
      lastFour: k.lastFour,
      scopes: k.scopes,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ctx.authMethod !== "session") {
    return NextResponse.json(
      { error: "PAT auth cannot mint tokens — sign in with the web UI" },
      { status: 403 }
    );
  }

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid body", detail: String(err) },
      { status: 400 }
    );
  }

  const created = await createApiKey({
    userId: ctx.user.id,
    name: body.name,
    scopes: body.scopes as ApiKeyScope[],
    expiresInDays: body.expiresInDays ?? null,
  });

  // Phase 3.2 — audit. Token mint is user-scoped (no workspaceId column on
  // api_keys), so the audit row has no workspaceId either.
  void recordAuditEvent({
    workspaceId: null,
    userId: ctx.user.id,
    action: AuditAction.TokenMint,
    targetType: "api_key",
    targetId: created.id,
    metadata: {
      name: created.name,
      scopes: created.scopes,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    },
    request: req,
  });

  // The plaintext `token` is returned EXACTLY ONCE here. The client must
  // surface it to the user immediately and never persist it.
  return NextResponse.json({
    id: created.id,
    name: created.name,
    prefix: created.prefix,
    firstFour: created.firstFour,
    lastFour: created.lastFour,
    scopes: created.scopes,
    expiresAt: created.expiresAt?.toISOString() ?? null,
    createdAt: created.createdAt.toISOString(),
    token: created.token,
  });
}
