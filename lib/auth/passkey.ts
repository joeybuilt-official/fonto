// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Passkey registration + authentication flows (ADR-004).
// Uses @simplewebauthn/server. rpId = myfonto.com. residentKey: required.
// Credentials stored in auth.passkey_credentials via raw SQL.

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

const RP_ID = process.env.PASSKEY_RP_ID ?? "myfonto.com";
const RP_NAME = process.env.PASSKEY_RP_NAME ?? "Fonto";
const ORIGIN = process.env.PASSKEY_ORIGIN ?? `https://${RP_ID}`;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function startRegistration(userId: string, userEmail: string) {
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(userId),
    userName: userEmail,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
    excludeCredentials: await getCredentialDescriptors(userId),
  });

  // Store challenge. Two separate statements — postgres-js (extended protocol)
  // rejects multiple commands in one parameterized execute.
  await db.execute(sql`DELETE FROM auth.passkey_challenges WHERE user_id = ${userId}`);
  await db.execute(sql`
    INSERT INTO auth.passkey_challenges (user_id, challenge)
    VALUES (${userId}, ${opts.challenge})
  `);

  return opts;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON
) {
  const rows = await db.execute<{ challenge: string }>(sql`
    SELECT challenge FROM auth.passkey_challenges
    WHERE user_id = ${userId} AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1
  `);

  const challengeRow = (rows as unknown as Array<{ challenge: string }>)[0];
  if (!challengeRow) throw new Error("No active challenge for user");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  await db.execute(sql`DELETE FROM auth.passkey_challenges WHERE user_id = ${userId}`);
  await db.execute(sql`
    INSERT INTO auth.passkey_credentials
      (id, user_id, user_handle, public_key, counter, device_type, backed_up, transports)
    VALUES (
      ${credential.id},
      ${userId},
      ${userId},
      ${Buffer.from(credential.publicKey)}::bytea,
      ${credential.counter},
      ${credentialDeviceType},
      ${credentialBackedUp},
      ${(response.response.transports ?? []) as string[]}
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
    userVerification: "preferred",
    allowCredentials: credentials,
  });

  const challengeUserId = userId ?? "__anon__";
  await db.execute(sql`DELETE FROM auth.passkey_challenges WHERE user_id = ${challengeUserId}`);
  await db.execute(sql`
    INSERT INTO auth.passkey_challenges (user_id, challenge)
    VALUES (${challengeUserId}, ${opts.challenge})
  `);

  return opts;
}

export async function finishAuthentication(
  response: AuthenticationResponseJSON,
  sessionUserId?: string
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
    FROM auth.passkey_credentials WHERE id = ${credId}
  `);

  const cred = (credRows as unknown as Array<{ id: string; user_id: string; user_handle: string; public_key: Buffer; counter: number; transports: string[] }>)[0];
  if (!cred) throw new Error("Credential not found");

  const challengeUserId = sessionUserId ?? "__anon__";
  const challengeRows = await db.execute<{ challenge: string }>(sql`
    SELECT challenge FROM auth.passkey_challenges
    WHERE user_id = ${challengeUserId} AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1
  `);

  const challengeRow = (challengeRows as unknown as Array<{ challenge: string }>)[0];
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
    requireUserVerification: false,
  });

  if (!verification.verified) throw new Error("Authentication verification failed");

  await db.execute(sql`
    UPDATE auth.passkey_credentials
    SET counter = ${verification.authenticationInfo.newCounter},
        last_used_at = now()
    WHERE id = ${credId}
  `);
  await db.execute(sql`DELETE FROM auth.passkey_challenges WHERE user_id = ${challengeUserId}`);

  return { verified: true, userId: cred.user_id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCredentialDescriptors(userId: string) {
  const rows = await db.execute<{ id: string; transports: string[] }>(sql`
    SELECT id, transports FROM auth.passkey_credentials WHERE user_id = ${userId}
  `);
  return (rows as unknown as Array<{ id: string; transports: string[] }>).map((r) => ({
    id: r.id,
    transports: r.transports as AuthenticatorTransportFuture[],
  }));
}
