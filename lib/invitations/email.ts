// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Transactional email — invitations + password reset.
//
// Single, dependency-free transport: Resend's HTTP API via `fetch` (the same
// provider the deploy already documents as `RESEND_API_KEY` in .env.example).
// No nodemailer / react-email dependency is pulled in — one `fetch` call keeps
// the footprint tiny and works in the Next.js server runtime.
//
// Graceful when unconfigured: with `RESEND_API_KEY` unset, `deliverEmail`
// logs and returns `{ sent: false }` instead of throwing, so an operator who
// hasn't wired email yet still gets a working app (invitation callers fall
// back to sharing the URL; password-reset silently no-ops, which also avoids
// leaking whether an address exists).
//
// Required env for real delivery:
//   RESEND_API_KEY   — Resend API key (re_...)
//   EMAIL_FROM       — From header, e.g. "Fonto <noreply@myfonto.com>"
//                      (defaults to noreply@myfonto.com when unset)
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

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Minimal HTML escape for values interpolated into an email body. */
function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "Fonto <noreply@myfonto.com>";
}

/**
 * Deliver one email via Resend's HTTP API. Returns `{ sent }` so callers can
 * decide whether to surface a "share the link manually" fallback. Throws only
 * on a real transport error (non-2xx from Resend) so background callers can
 * log it; an unconfigured transport is a soft no-op, not an error.
 */
async function deliverEmail(msg: EmailMessage): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.info(
      { to: msg.to, subject: msg.subject },
      "email.transport_unconfigured: RESEND_API_KEY unset — email not sent"
    );
    return { sent: false };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.error(
      { to: msg.to, subject: msg.subject, status: res.status, detail },
      "email.send_failed"
    );
    throw new Error(`Email send failed: HTTP ${res.status}`);
  }

  logger.info({ to: msg.to, subject: msg.subject }, "email.sent");
  return { sent: true };
}

/**
 * Send the workspace invitation email. Keeps its original signature and
 * `{ ok, sent }` return so callers (`POST /api/v1/workspace/invitations`)
 * don't change. `sent` is `false` when no transport is configured.
 */
export async function sendInvitationEmail(
  payload: InvitationEmailPayload
): Promise<{ ok: true; sent: boolean }> {
  const inviter = payload.inviterName?.trim() || payload.inviterEmail;
  const subject = `You're invited to ${payload.workspaceName} on Fonto`;
  const expires = payload.expiresAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
  <p style="font-size:20px;font-weight:600"><span style="color:#2563eb">_</span>fonto</p>
  <p>${esc(inviter)} invited you to join <strong>${esc(payload.workspaceName)}</strong> as a ${esc(payload.role)}.</p>
  <p><a href="${esc(payload.acceptUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
  <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${esc(payload.acceptUrl)}</p>
  <p style="color:#666;font-size:13px">This invitation expires on ${esc(expires)}.</p>
</div>`;
  const text = `${inviter} invited you to join ${payload.workspaceName} as a ${payload.role}.

Accept the invitation:
${payload.acceptUrl}

This invitation expires on ${expires}.`;

  const { sent } = await deliverEmail({ to: payload.to, subject, html, text });
  return { ok: true, sent };
}

export interface PasswordResetEmailPayload {
  to: string;
  /** Fully-qualified reset URL minted by Better Auth's sendResetPassword. */
  resetUrl: string;
}

/**
 * Send the password-reset email. Wired into Better Auth's
 * `emailAndPassword.sendResetPassword` (see lib/auth.ts), which invokes it in
 * the background — so a transport error is logged, never surfaced to the
 * requester (avoids leaking whether an address is registered).
 */
export async function sendPasswordResetEmail(
  payload: PasswordResetEmailPayload
): Promise<{ ok: true; sent: boolean }> {
  const subject = "Reset your Fonto password";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
  <p style="font-size:20px;font-weight:600"><span style="color:#2563eb">_</span>fonto</p>
  <p>We received a request to reset your password. Click below to choose a new one:</p>
  <p><a href="${esc(payload.resetUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
  <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${esc(payload.resetUrl)}</p>
  <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email — your password won't change.</p>
</div>`;
  const text = `We received a request to reset your Fonto password.

Reset it here:
${payload.resetUrl}

If you didn't request this, ignore this email — your password won't change.`;

  const { sent } = await deliverEmail({ to: payload.to, subject, html, text });
  return { ok: true, sent };
}
