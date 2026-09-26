// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Passkey registration + authentication flows (ADR-004).
// Uses @simplewebauthn/server. residentKey: required.
// Credentials stored in fonto.passkey_credentials via raw SQL.
//
// rpId resolution (see rpId() below): PASSKEY_RP_ID if set, else the host of
// PASSKEY_ORIGIN / BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL, else "localhost".
// There is deliberately NO hardcoded production hostname — this repo is public.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/types";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * The WebAuthn relying-party id — the registrable domain a credential is bound
 * to. This is LOAD-BEARING and effectively permanent: the rpId is stored inside
 * every registered credential, so changing it invalidates all existing passkeys
 * for the instance (users must re-register).
 *
 * Resolution order:
 *   1. PASSKEY_RP_ID           — explicit, always wins. Set this in production.
 *   2. host of PASSKEY_ORIGIN / BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL
 *   3. "localhost"             — dev fallback (WebAuthn allows localhost)
 *
 * Falling back to "localhost" rather than a real domain means a misconfigured
 * production deploy cannot silently mint credentials bound to somebody else's
 * hostname, and it cannot bind them to a domain the deployer does not control.
 * It does mean an operator who sets no origin env at all gets a
 * localhost-scoped rpId — which fails closed (passkeys unusable outside dev)
 * rather than insecurely.
 */
function rpId(): string {
  const explicit = process.env.PASSKEY_RP_ID;
  if (explicit) return explicit;
  for (const raw of [
    process.env.PASSKEY_ORIGIN,
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    if (!raw) continue;
    try {
      return new URL(raw).hostname;
    } catch {
      // A bare host ("fonto.example.com") is a legal rpId even though it is not
      // a parseable URL. Accept it; reject anything with a path/scheme we
      // cannot reason about.
      if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(raw)) {
        return raw;
      }
    }
  }
  return "localhost";
}

const RP_ID = rpId();
const RP_NAME = process.env.PASSKEY_RP_NAME ?? "Fonto";
const ORIGIN = process.env.PASSKEY_ORIGIN ?? `https://${RP_ID}`;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function startRegistration(userId: string, userEmail: string) {
  // Opaque userHandle (ADR-004 C1): never the local Better Auth user id. All
  // of a user's credentials share one handle — reuse an existing one.
  const handleRows = await db.execute<{ user_handle: string }>(sql`
    SELECT user_handle FROM fonto.passkey_credentials
    WHERE user_id = ${userId} LIMIT 1
  `);
  const userHandle =
    (handleRows as unknown as Array<{ user_handle: string }>)[0]?.user_handle ??
    crypto.randomUUID();

  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(userHandle),
    userName: userEmail,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: await getCredentialDescriptors(userId),
  });

  // Store challenge. Two separate statements — postgres-js (extended protocol)
  // rejects multiple commands in one parameterized execute.
  await db.execute(sql`DELETE FROM fonto.passkey_challenges WHERE user_id = ${userId}`);
  await db.execute(sql`
    INSERT INTO fonto.passkey_challenges (user_id, challenge, user_handle)
    VALUES (${userId}, ${opts.challenge}, ${userHandle})
  `);

  return opts;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON
) {
  const rows = await db.execute<{ challenge: string; user_handle: string | null }>(sql`
    SELECT challenge, user_handle FROM fonto.passkey_challenges
    WHERE user_id = ${userId} AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1
  `);

  const challengeRow = (rows as unknown as Array<{ challenge: string; user_handle: string | null }>)[0];
  if (!challengeRow?.user_handle) throw new Error("No active challenge for user");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  await db.execute(sql`DELETE FROM fonto.passkey_challenges WHERE user_id = ${userId}`);
  await db.execute(sql`
    INSERT INTO fonto.passkey_credentials
      (id, user_id, user_handle, public_key, counter, device_type, backed_up, transports)
    VALUES (
      ${credential.id},
      ${userId},
      ${challengeRow.user_handle},
      ${Buffer.from(credential.publicKey)}::bytea,
      ${credential.counter},
      ${credentialDeviceType},
      ${credentialBackedUp},
      ${`{${(response.response.transports ?? []).join(",")}}`}::text[]
    )
    ON CONFLICT (id) DO UPDATE
      SET counter = EXCLUDED.counter,
          last_used_at = now()
  `);

  return { verified: true, credentialId: credential.id };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function startAuthentication(userId?: string) {
  const credentials = userId ? await getCredentialDescriptors(userId) : [];

  const opts = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    allowCredentials: credentials,
  });

  // Anon challenges are challenge-keyed (concurrent anonymous logins must not
  // clobber each other) — only expired rows are reaped. One statement per
  // execute: postgres-js rejects multi-command parameterized queries.
  const challengeUserId = userId ?? "__anon__";
  if (userId) {
    await db.execute(sql`DELETE FROM fonto.passkey_challenges WHERE user_id = ${userId}`);
  } else {
    await db.execute(sql`DELETE FROM fonto.passkey_challenges WHERE expires_at < now()`);
  }
  await db.execute(sql`
    INSERT INTO fonto.passkey_challenges (user_id, challenge)
    VALUES (${challengeUserId}, ${opts.challenge})
  `);

  return opts;
}

export async function finishAuthentication(
  response: AuthenticationResponseJSON,
  _sessionUserId?: string
) {
  const credId = response.id;
  const credRows = await db.execute<{
    id: string;
    user_id: string;
    user_handle: string;
    public_key: Buffer;
    counter: number;
    transports: string[];
  }>(sql`
    SELECT id, user_id, user_handle, public_key, counter, transports
    FROM fonto.passkey_credentials WHERE id = ${credId}
  `);

  const cred = (credRows as unknown as Array<{ id: string; user_id: string; user_handle: string; public_key: Buffer; counter: number; transports: string[] }>)[0];
  if (!cred) throw new Error("Credential not found");

  // Challenge-keyed lookup: the clientDataJSON echoes the exact base64url
  // challenge string we stored at start — no user_id ambiguity, no anon races.
  let clientChallenge: string | undefined;
  try {
    const clientData = JSON.parse(
      Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")
    ) as { challenge?: string };
    clientChallenge = clientData.challenge;
  } catch {
    throw new Error("No active challenge");
  }
  if (!clientChallenge) throw new Error("No active challenge");

  // Atomic single-use claim: the DELETE consumes the challenge in the same
  // statement that fetches it, so two racing finishes can never both verify
  // against one challenge.
  const challengeRows = await db.execute<{ id: string; challenge: string }>(sql`
    DELETE FROM fonto.passkey_challenges
    WHERE challenge = ${clientChallenge} AND expires_at > now()
    RETURNING id, challenge
  `);

  const challengeRow = (challengeRows as unknown as Array<{ id: string; challenge: string }>)[0];
  if (!challengeRow) throw new Error("No active challenge");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(cred.public_key),
      counter: cred.counter,
      transports: cred.transports as AuthenticatorTransportFuture[],
    },
    requireUserVerification: true,
  });

  if (!verification.verified) throw new Error("Authentication verification failed");

  await db.execute(sql`
    UPDATE fonto.passkey_credentials
    SET counter = ${verification.authenticationInfo.newCounter},
        last_used_at = now()
    WHERE id = ${credId}
  `);

  return { verified: true, userId: cred.user_id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCredentialDescriptors(userId: string) {
  const rows = await db.execute<{ id: string; transports: string[] }>(sql`
    SELECT id, transports FROM fonto.passkey_credentials WHERE user_id = ${userId}
  `);
  return (rows as unknown as Array<{ id: string; transports: string[] }>).map((r) => ({
    id: r.id,
    transports: r.transports as AuthenticatorTransportFuture[],
  }));
}
