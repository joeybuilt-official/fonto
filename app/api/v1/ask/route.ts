// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — stub AI ask endpoint. The AssetAskPanel posts here; until the real
// chat backend lands, this returns a "coming soon" message that carries
// enough context (contextAssetIds count) for the UI to render meaningfully.
//
// When the real backend is built, swap the body of POST() for a call into
// the chat module — the request/response shape is the seam.
//
// Request:
//   POST /api/v1/ask
//   { "messages": [{ "role": "user", "content": "..." }, ...],
//     "contextAssetIds": ["<uuid>", ...] }
//
// Response:
//   { "message": "...", "stub": true }      // current behaviour
//   { "message": "...", "citations": [...] } // future, when wired to a model

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messages = Array.isArray((body as { messages?: unknown }).messages)
    ? ((body as { messages: unknown[] }).messages.filter(
        (m): m is { role: string; content: string } =>
          typeof m === "object" && m !== null &&
          typeof (m as { content?: unknown }).content === "string"
      ))
    : [];
  const contextIds = Array.isArray((body as { contextAssetIds?: unknown }).contextAssetIds)
    ? ((body as { contextAssetIds: unknown[] }).contextAssetIds.filter(
        (x): x is string => typeof x === "string"
      ))
    : [];

  const last = messages[messages.length - 1];
  const userQuery = last?.content ?? "(no question)";

  return NextResponse.json({
    message:
      `AI chat is coming soon. You asked: "${userQuery.slice(0, 200)}". ` +
      `I would have searched across ${contextIds.length} asset${
        contextIds.length === 1 ? "" : "s"
      } scoped to your current view.`,
    stub: true,
  });
}
