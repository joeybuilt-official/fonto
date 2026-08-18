// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Mobile auth-handoff redemption endpoint.
//
// The native app receives a short-lived single-use exchange CODE via the
// /mobile/auth-callback deep link (minted in app/mobile/auth-handoff), then
// POSTs it here to redeem the underlying PAT exactly once. See
// lib/auth/mobile-exchange.ts for the store + threat model.
//
// This route is called by the NATIVE HTTP client, not a browser: there is no
// session cookie and no ambient authority — the unguessable code IS the
// credential. CSRF is therefore not applicable (a cross-site page cannot read
// the JSON response without CORS, which we do not grant, and could not guess
// the code anyway). The only hardening that matters here is `no-store` so the
// PAT is never cached by any intermediary.

import { NextResponse } from "next/server";
import { redeemMobileExchangeCode } from "@/lib/auth/mobile-exchange";

export const dynamic = "force-dynamic";

const NO_STORE: Record<string, string> = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  let code: unknown;
  try {
    const body = (await req.json()) as unknown;
    code = (body as { code?: unknown } | null)?.code;
  } catch {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: NO_STORE }
    );
  }

  if (typeof code !== "string" || code.length === 0) {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: NO_STORE }
    );
  }

  const pat = await redeemMobileExchangeCode(code);
  if (!pat) {
    // Unknown, malformed, expired, already-redeemed, or store unavailable.
    // Uniform 400 so the endpoint isn't an oracle distinguishing those cases.
    return NextResponse.json(
      { error: "invalid_or_expired_code" },
      { status: 400, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    { pat, tokenType: "bearer" },
    { status: 200, headers: NO_STORE }
  );
}
