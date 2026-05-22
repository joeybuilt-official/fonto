// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.4: App Router ↔ @tus/server adapter.
//
// @tus/server v2 exposes `handleWeb(request: Request): Promise<Response>`
// which speaks the standard Fetch API — meaning the gnarly "convert a Web
// Request to a Node http.IncomingMessage" adapter the original plan warned
// about is no longer necessary. This file is the thin wrapper that:
//
//   1. forwards the App Router Web Request to the tus server, AND
//   2. layers CORS response headers on top so browsers can talk to the tus
//      endpoint cross-origin (e.g. a CLI hosted elsewhere, or a future
//      desktop client).
//
// The route handler at `app/api/v1/uploads/tus/[...path]/route.ts` calls
// the verb-specific helpers here so the route file stays a one-liner.

import { handleTusRequest } from "@/lib/tus/server";

/**
 * CORS headers exposed on every tus response. The tus spec requires the
 * client to be able to read protocol-level headers like `Upload-Offset`
 * even in cross-origin contexts.
 */
const TUS_EXPOSED_HEADERS = [
  "Location",
  "Upload-Offset",
  "Upload-Length",
  "Tus-Version",
  "Tus-Resumable",
  "Tus-Max-Size",
  "Tus-Extension",
  "Upload-Metadata",
  "X-Fonto-Asset-Id",
].join(", ");

const TUS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Requested-With",
  "Tus-Resumable",
  "Upload-Length",
  "Upload-Offset",
  "Upload-Metadata",
  "Upload-Defer-Length",
  "Upload-Concat",
].join(", ");

const TUS_ALLOWED_METHODS = "POST, HEAD, PATCH, DELETE, OPTIONS, GET";

/**
 * Decide what to echo for Access-Control-Allow-Origin. For now we trust the
 * caller's Origin header — same-origin requests always succeed; cross-origin
 * requests from the future CLI / desktop client (which set their own Origin)
 * are accepted as long as the auth check downstream passes. Tighten this
 * later if needed by reading an env allowlist.
 */
function allowOriginFor(request: Request): string {
  return request.headers.get("origin") ?? "*";
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOriginFor(request));
  headers.set("Access-Control-Allow-Methods", TUS_ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", TUS_ALLOWED_HEADERS);
  headers.set("Access-Control-Expose-Headers", TUS_EXPOSED_HEADERS);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");
  // Always advertise that we speak tus 1.0.0 on every response.
  if (!headers.has("Tus-Resumable")) headers.set("Tus-Resumable", "1.0.0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Handle a non-OPTIONS tus verb by forwarding to @tus/server. */
export async function tusHandle(request: Request): Promise<Response> {
  try {
    const response = await handleTusRequest(request);
    return withCors(request, response);
  } catch (err) {
    console.error("[fonto-tus] unhandled tus error:", err);
    return withCors(
      request,
      new Response(JSON.stringify({ error: "Internal tus error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
}

/**
 * Pre-flight handler — tus's OptionsHandler already returns the protocol
 * headers (Tus-Version etc), so we hand off to it and just layer CORS on.
 */
export async function tusOptions(request: Request): Promise<Response> {
  // For a true CORS pre-flight (Access-Control-Request-Method present),
  // browsers expect a 204 with the allow-* headers and no body. tus's
  // OptionsHandler already does the right thing for non-preflight OPTIONS
  // (returning Tus-Version etc), so we always defer to it and trust the
  // CORS layer to add what's missing.
  return tusHandle(request);
}
