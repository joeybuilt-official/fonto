// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Workspace invitation email send — STUB.
//
// Phase 3.3 ships invitations without an email transport on purpose; the
// parity plan defers email infrastructure (nodemailer + react-email) to
// Phase 7.3 ("Email + in-app notifications"). Until then the invitation
// API returns the token + URL in the response so an inviter can paste it
// into their preferred channel.
//
// When Phase 7.3 lands: wire this function into the chosen transport,
// render a real template, and keep the same signature so call sites
// (`POST /api/v1/workspace/invitations`) don't need to change.
import { logger } from "@/lib/logger";

export interface InvitationEmailPayload {
  to: string;
  workspaceName: string;
  inviterEmail: string;
  inviterName: string | null;
  role: "editor" | "viewer";
  acceptUrl: string;
  expiresAt: Date;
}

/**
 * Send the invitation email. TODO(Phase 7.3): replace with a real send.
 *
 * Returns `{ ok: true, sent: false }` to make the no-op explicit; callers
 * can surface "email not configured — share the URL manually" if they want.
 */
export async function sendInvitationEmail(
  payload: InvitationEmailPayload
): Promise<{ ok: true; sent: boolean }> {
  // No transport configured yet — log and continue. We log the destination
  // so admins running the dev stack can copy the URL from server logs if
  // they can't easily hit the API response.
  logger.info(
    {
      to: payload.to,
      workspaceName: payload.workspaceName,
      acceptUrl: payload.acceptUrl,
      expiresAt: payload.expiresAt.toISOString(),
    },
    "workspace_invitations.email_stub: would send invitation email"
  );
  return { ok: true, sent: false };
}
