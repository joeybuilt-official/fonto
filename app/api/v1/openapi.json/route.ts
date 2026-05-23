// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `GET /api/v1/openapi.json` — emits the OpenAPI 3.1 document derived from
// the Zod registry in `lib/openapi/{registry,routes}.ts`.
//
// We generate at request time (not at build time) because the generator is
// cheap and this keeps the spec in lock-step with whatever code is running.
// A 5-minute Cache-Control caps the cost for documentation crawlers.
import { NextResponse } from "next/server";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { registry } from "@/lib/openapi/registry";
// Importing for side effects: this file populates `registry` via
// `registerPath` calls.
import "@/lib/openapi/routes";

// `nodejs` (not edge) — zod-to-openapi reaches into internals that don't
// always tree-shake cleanly on the edge runtime.
export const runtime = "nodejs";

export async function GET() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Fonto API",
      version: "0.1.0",
      description:
        "Fonto's public REST API. Authenticate via session cookie (web client), " +
        "personal access token (`Authorization: Bearer fonto_pat_...`), or the " +
        "equivalent `x-api-key` header.",
      license: { name: "AGPL-3.0", url: "https://www.gnu.org/licenses/agpl-3.0.txt" },
    },
    servers: [{ url: "/", description: "Same-origin" }],
  });

  return NextResponse.json(document, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
