// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /.well-known/jex.manifest.json — the Jex capability manifest.
//
// The manifest lives at `public/.well-known/jex.manifest.json` (fetchable as a
// static asset) and this route serves the SAME import, so the two can never
// diverge — an agent that hits the route and one that reads the file get
// identical bytes.
//
// The import must be RELATIVE from this file's own directory. Under the
// app-router baseUrl the `@/../public/…` alias import resolves inside-app and
// the production build fails with "Can't resolve '@/../public/.well-known/
// jex.manifest.json'" (hit on PR #7's first CI run); dev mode masked it.
// `app/.well-known/jex.manifest.json/` is 3 dirs below the repo root:
// jex.manifest.json/ → app/.well-known → app → repo root. (A first relative
// attempt with `../../../../` went one dir too far and failed typecheck the
// same way dev mode had masked the original alias break.)
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import manifest from "../../../public/.well-known/jex.manifest.json";

export async function GET() {
  return NextResponse.json(manifest, {
    headers: {
      // Static for the deploy: an agent may cache it, and an operator can diff
      // two deploys by URL alone.
      "Cache-Control": "public, max-age=300",
    },
  });
}
