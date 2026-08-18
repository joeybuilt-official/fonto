// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Passkey registration route — two-step: POST {step:"start"} → challenge,
// POST {step:"finish", response} → verified credential.
// Requires an authenticated Better Auth session.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  startRegistration,
  finishRegistration,
} from "@/lib/auth/passkey";
import { headers } from "next/headers";

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? userId;

  const body = (await req.json()) as { step: string; response?: unknown };

  try {
    if (body.step === "start") {
      const opts = await startRegistration(userId, userEmail);
      return NextResponse.json(opts);
    }

    if (body.step === "finish") {
      const result = await finishRegistration(userId, body.response as import("@simplewebauthn/types").RegistrationResponseJSON);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Invalid step" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Registration failed" },
      { status: 400 }
    );
  }
}
