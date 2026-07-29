// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.4 — tus protocol endpoint.
//
// Catch-all route that mounts @tus/server at /api/v1/uploads/tus and accepts
// resumable uploads for any path beneath it. The optional catch-all
// `[[...path]]` means a POST to the bare endpoint (upload creation) and
// PATCH/HEAD/DELETE on `/api/v1/uploads/tus/{uploadId}` (chunk / status /
// cancel) both land here.
//
// All the protocol behavior lives in `lib/tus/server.ts`; this file is a
// thin verb dispatcher that hands the App Router Web Request to the
// adapter and lets tus produce a Web Response.

import { tusHandle, tusOptions } from "@/lib/tus/adapter";

// tus needs Node APIs (streams, S3 multipart) — never run on edge.
export const runtime = "nodejs";
// tus requests stream chunks; we must not let Next.js cache or static-opt
// this endpoint.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return tusHandle(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return tusHandle(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return tusHandle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return tusHandle(request);
}

export async function GET(request: Request): Promise<Response> {
  // tus has an optional GET-extension some clients use to read partial
  // state; we just defer to the server which 405s if disabled.
  return tusHandle(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return tusOptions(request);
}
