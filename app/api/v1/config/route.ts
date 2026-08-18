// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos/Files split — client feature-flag config.
//
// Single source of truth for server-controlled feature flags that BOTH the
// web client and the installed mobile app read at runtime, so the operator can
// flip a flag in prod (env var) without rebuilding/reshipping either client.
// Returns only booleans — no secrets — so it is safe unauthenticated.

const flag = (v: string | undefined) => v === "1" || v === "true";

export async function GET() {
  return Response.json({
    features: {
      // Promotes the Library `kind` lens row into a Photos/Files segmented
      // control with an Inbox holding area for unclassified assets. OFF in
      // prod until the operator validates and runs the presplit sweep.
      librarySurfaceSplit: flag(process.env.LIBRARY_SURFACE_SPLIT_ENABLED),
    },
  });
}
