// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// POST /api/peer/v1/events — Fonto's PUBLISHED inbound event surface.
//
// Any authorized peer that has registered an event contract with Fonto (see
// `jex.manifest.json` → `eventContracts`) may POST here. Requests are signed
// with HMAC-SHA256 over the raw body using `FONTO_SERVICE_KEY` and carry the
// signature in `x-fonto-signature`.
//
// This is Fonto's own endpoint with Fonto's own credential — a peer pairs
// against it over the wire. No sibling app's route is called, and Fonto holds
// no credential on anyone else's behalf.
//
// An unconfigured key returns 503 FEATURE_DISABLED, which is a configuration
// state (this optional surface is off), not an outage of a core flow.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";
import { isPeerSurfaceConfigured } from "@/lib/peer/service-keys";

const SIGNATURE_HEADER = "x-fonto-signature";

function verifySignature(body: string, signature: string | null): boolean {
  const secret = process.env.FONTO_SERVICE_KEY;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Event contracts Fonto publishes. Keep in sync with `jex.manifest.json`. */
const VALID_EVENTS = new Set([
  "fonto.asset.uploaded",
  "fonto.asset.processed",
  "fonto.asset.classified",
  "fonto.asset.deleted",
  "fonto.asset.purged",
  "fonto.tag.created",
]);

interface PeerEvent {
  event: string;
  assetId?: string;
  workspaceId?: string;
  userId?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  if (!isPeerSurfaceConfigured()) {
    return NextResponse.json(
      { error: "Peer event surface is not enabled", code: "FEATURE_DISABLED" },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: PeerEvent;
  try {
    payload = JSON.parse(rawBody) as PeerEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload.event || !VALID_EVENTS.has(payload.event)) {
    return NextResponse.json(
      { error: `Unknown event: ${payload.event}` },
      { status: 400 }
    );
  }

  if (!payload.timestamp) {
    return NextResponse.json(
      { error: "timestamp required" },
      { status: 400 }
    );
  }

  logger.info(
    {
      event: payload.event,
      assetId: payload.assetId,
      workspaceId: payload.workspaceId,
      timestamp: payload.timestamp,
    },
    "[peer/events]"
  );

  return NextResponse.json({ ok: true });
}
