// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * `GET /api/health` — generic readiness response.
 *
 * `?check=vector` switches to the pgvector probe used by deploy gating
 * (Phase 4.3, ADR 0002). It casts a tiny literal through the `vector` type;
 * a green response means the extension is installed and the role can use
 * it. Anything else (missing extension, missing GRANT) returns 503.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const check = url.searchParams.get("check");

  if (check === "vector") {
    try {
      await db.execute(sql`SELECT '[1]'::vector(1) AS probe`);
      return Response.json({
        ok: true,
        check: "vector",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return Response.json(
        {
          ok: false,
          check: "vector",
          error: err instanceof Error ? err.message : String(err),
          hint:
            "pgvector extension is not available on DATABASE_URL. " +
            "Install postgresql-NN-pgvector on the host and re-run migration 0017.",
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }
  }

  return Response.json({
    ok: true,
    appId: "fonto",
    schemaNamespace: process.env.APP_SCHEMA_NAMESPACE ?? null,
    // The app's OWN intelligence tiers, reported honestly. `complete` is
    // available when a user connection or the deployment env supplies one;
    // `vision` when a vision sidecar URL is configured. Neither is required
    // for the app to be healthy — absent is a supported state.
    intelligence: {
      complete: !!(process.env.AI_BASE_URL || process.env.AI_API_KEY || process.env.FONTO_LLM_KEY),
      vision: !!process.env.FONTO_VISION_URL,
      userConnections: true,
    },
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    emailConfigured: !!process.env.RESEND_API_KEY,
    timestamp: new Date().toISOString(),
  });
}
