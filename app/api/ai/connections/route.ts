// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// User-configurable AI connections — the app-owned LLM configuration surface.
//
// GET    /api/ai/connections          list (never returns a plaintext key)
// POST   /api/ai/connections          create, or update when `id` is present
// DELETE /api/ai/connections?id=…     remove
// PATCH  /api/ai/connections          make one connection the default
//
// Session-authenticated: a connection belongs to exactly one user, and a user
// can only see or change their own. The API key is encrypted at rest by
// `lib/ai/connections.ts` and is never returned by any read path — the list
// exposes a masked last-4 so the UI can show "key set" honestly.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import {
  deleteAiConnection,
  isEnvAiConnectionAvailable,
  listAiConnections,
  saveAiConnection,
  setDefaultAiConnection,
} from "@/lib/ai/connections";

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(60),
  baseUrl: z.string().min(1).max(500),
  model: z.string().min(1).max(200),
  apiKey: z.string().optional(),
  isDefault: z.boolean().optional(),
});

const defaultSchema = z.object({ id: z.string().uuid() });

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const connections = await listAiConnections(user.id);
  // `envFallbackAvailable` tells the UI whether AI resolves to a
  // deployment-supplied connection when the user has none — the honest answer
  // to "will this work?".
  return NextResponse.json({
    connections,
    envFallbackAvailable: isEnvAiConnectionAvailable(),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const result = await saveAiConnection(user.id, parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, fieldErrors: result.fieldErrors },
      { status: 400 }
    );
  }
  return NextResponse.json({ connection: result.connection });
}

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = defaultSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ok = await setDefaultAiConnection(user.id, parsed.data.id);
  if (!ok) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const ok = await deleteAiConnection(user.id, id);
  if (!ok) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
