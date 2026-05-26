// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — daily activity digest email send — STUB.
//
// Same pattern as lib/invitations/email.ts: email transport is deferred
// to Phase 7.3. Until then this function logs the intent + the rendered
// plaintext body so a dev running the worker can see exactly what would
// have been sent. Signature is the contract the digest job depends on —
// when transport lands in 7.3, swap the body of this function and
// upstream callers stay unchanged.

import { logger } from "@/lib/logger";

export interface DigestActivityLine {
  // Pre-rendered single-line summary, e.g. "@alice commented on
  // 'beach.jpg': Looks great!". The renderer is in
  // lib/notifications/renderDigest.ts and stays out of this transport
  // boundary so the template can evolve without changing the send call.
  text: string;
  // Best-effort deep link into the web UI (asset detail, activity feed,
  // etc.). Optional — some event kinds don't have a clean target URL.
  link?: string;
  occurredAt: Date;
}

export interface DigestEmailPayload {
  to: string;
  workspaceName: string;
  // The recipient's display name (or email-local-part fallback) — used
  // as the email's salutation.
  recipientName: string;
  // Range covered by this digest. `since` is the previous digest's
  // cursor (or 24h ago for first-time recipients); `until` is the
  // generation timestamp.
  since: Date;
  until: Date;
  lines: DigestActivityLine[];
  // Pre-rendered plaintext body (joining `lines` with light formatting).
  // We render here rather than at send-time so the transport layer can
  // stay format-agnostic when Phase 7.3 chooses a templating engine.
  bodyPlaintext: string;
  // Link to the recipient's notification settings — every digest email
  // includes "unsubscribe / change preferences" out of legal courtesy
  // and good UX hygiene.
  preferencesUrl: string;
}

export async function sendDigestEmail(
  payload: DigestEmailPayload
): Promise<{ ok: true; sent: boolean }> {
  logger.info(
    {
      to: payload.to,
      workspaceName: payload.workspaceName,
      lineCount: payload.lines.length,
      since: payload.since.toISOString(),
      until: payload.until.toISOString(),
      preferencesUrl: payload.preferencesUrl,
    },
    "notifications.digest.email_stub: would send daily digest"
  );
  // In dev, also dump the body so the developer can copy-paste it.
  if (process.env.NODE_ENV !== "production") {
    logger.debug({ body: payload.bodyPlaintext }, "notifications.digest.email_body_preview");
  }
  return { ok: true, sent: false };
}
