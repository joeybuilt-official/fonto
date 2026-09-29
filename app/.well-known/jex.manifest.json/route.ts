// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /.well-known/jex.manifest.json — the Jex capability manifest.
//
// The manifest lives at `public/.well-known/jex.manifest.json` (fetchable as a
// static asset) and this route serves the SAME import, so the two can never
// diverge — an agent that hits the route and one that reads the file get
// identical bytes.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import manifest from "@/../public/.well-known/jex.manifest.json";

export async function GET() {
  return NextResponse.json(manifest, {
    headers: {
      // Static for the deploy: an agent may cache it, and an operator can diff
      // two deploys by URL alone.
      "Cache-Control": "public, max-age=300",
    },
  });
}
