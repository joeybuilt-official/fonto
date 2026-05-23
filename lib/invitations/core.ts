// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Workspace invitations — token generation, lookup, lifecycle.
//
// Unlike PATs (lib/auth/api-keys.ts), invitation tokens are stored in
// plaintext. See the schema header for the security trade-off.
import { randomBytes } from "crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export type InvitationRole = "editor" | "viewer";

export const INVITATION_TOKEN_BYTES = 32;

/**
 * Generate a fresh URL-safe token. 32 bytes (256 bits) of entropy expressed
 * as base64url — long, unguessable, and safe in URL path segments.
 */
export function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

/**
 * Default invitation lifetime in days. Driven by env so a self-hosted
 * deploy can tighten or loosen it without a code change.
 */
export function getInvitationTtlDays(): number {
  const raw = process.env.WORKSPACE_INVITATION_TTL_DAYS;
  if (!raw) return 7;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 365) return 7;
  return n;
}

/**
 * Normalize an email for storage and comparison. We lower-case the whole
 * string — RFC 5321 technically lets the local-part be case-sensitive, but
 * no real mail server in 2026 cares and treating addresses as case-
 * insensitive matches user expectation and Better Auth's behaviour.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface CreateInvitationParams {
  workspaceId: string;
  email: string;
  role: InvitationRole;
  invitedBy: string;
  ttlDays?: number;
}

export async function createInvitation(params: CreateInvitationParams) {
  const ttl = params.ttlDays ?? getInvitationTtlDays();
  const expiresAt = new Date(Date.now() + ttl * 24 * 60 * 60 * 1000);
  const token = generateInvitationToken();

  const [row] = await db
    .insert(schema.workspaceInvitations)
    .values({
      workspaceId: params.workspaceId,
      email: normalizeEmail(params.email),
      role: params.role,
      token,
      invitedBy: params.invitedBy,
      expiresAt,
    })
    .returning();

  return row;
}

/**
 * Lookup an invitation by its public token. Returns the raw row regardless
 * of state — callers decide whether to honour it.
 */
export async function findInvitationByToken(token: string) {
  const rows = await db
    .select()
    .from(schema.workspaceInvitations)
    .where(eq(schema.workspaceInvitations.token, token))
    .limit(1);
  return rows[0] ?? null;
}

export async function findInvitationById(id: string) {
  const rows = await db
    .select()
    .from(schema.workspaceInvitations)
    .where(eq(schema.workspaceInvitations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * List pending (not accepted, not revoked, not expired) invitations for a
 * workspace, newest first. Powers the settings UI.
 */
export async function listPendingInvitations(workspaceId: string) {
  return db
    .select()
    .from(schema.workspaceInvitations)
    .where(
      and(
        eq(schema.workspaceInvitations.workspaceId, workspaceId),
        isNull(schema.workspaceInvitations.acceptedAt),
        isNull(schema.workspaceInvitations.revokedAt),
        gt(schema.workspaceInvitations.expiresAt, new Date())
      )
    )
    .orderBy(desc(schema.workspaceInvitations.createdAt));
}

export type InvitationState =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export function classifyInvitation(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationState {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "pending";
}

export async function revokeInvitation(id: string, workspaceId: string) {
  const result = await db
    .update(schema.workspaceInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.workspaceInvitations.id, id),
        eq(schema.workspaceInvitations.workspaceId, workspaceId),
        isNull(schema.workspaceInvitations.acceptedAt),
        isNull(schema.workspaceInvitations.revokedAt)
      )
    )
    .returning();
  return result[0] ?? null;
}

/**
 * Mark an invitation accepted. Caller is responsible for the
 * `workspace_memberships` insert; we just flip the accepted state.
 */
export async function markInvitationAccepted(
  id: string,
  acceptedByUserId: string
) {
  const result = await db
    .update(schema.workspaceInvitations)
    .set({
      acceptedAt: new Date(),
      acceptedByUserId,
    })
    .where(
      and(
        eq(schema.workspaceInvitations.id, id),
        isNull(schema.workspaceInvitations.acceptedAt),
        isNull(schema.workspaceInvitations.revokedAt),
        gt(schema.workspaceInvitations.expiresAt, new Date())
      )
    )
    .returning();
  return result[0] ?? null;
}
