// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Passkey authentication route — two-step: POST {step:"start"} → challenge,
// POST {step:"finish", response} → verified. Creates session via cookie.

import { NextRequest, NextResponse } from "next/server";
import {
  startAuthentication,
  finishAuthentication,
} from "@/lib/auth/passkey";
import { headers } from "next/headers";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { step: string; userId?: string; response?: unknown };

  try {
    if (body.step === "start") {
      const opts = await startAuthentication(body.userId);
      return NextResponse.json(opts);
    }

    if (body.step === "finish") {
      const { verified, userId } = await finishAuthentication(
        body.response as import("@simplewebauthn/types").AuthenticationResponseJSON,
        body.userId
      );
      if (!verified) {
        return NextResponse.json({ error: "Verification failed" }, { status: 401 });
      }

      // Return the verified userId so the client can trigger a Better Auth
      // sign-in (e.g. via a magic link or custom token flow).
      // ADR-004: session creation is handled by the calling client using
      // the app's existing Better Auth session mechanism.
      return NextResponse.json({ verified: true, userId });
    }

    return NextResponse.json({ error: "Invalid step" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Authentication failed" },
      { status: 400 }
    );
  }
}
