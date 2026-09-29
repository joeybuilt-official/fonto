// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// App-owned, user-configurable AI connections.
//
// Each user configures their own AI provider connection — label, base URL, API
// key, model — in Settings → Integrations. This module is the only place those
// credentials are read or written:
//
//   - The API key is AES-256-GCM encrypted before it touches the database
//     (`lib/crypto/secret-box.ts`, key derived from AUTH_SECRET).
//   - No read path ever returns the plaintext key. `listAiConnections` returns
//     a masked last-4 only, so the settings UI can show "key set" without ever
//     handing the secret back to a browser.
//   - Resolution is explicit: a caller may name a connection, otherwise the
//     user's default is used, and the environment-supplied connection
//     (`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`, with the legacy `FONTO_LLM_*`
//     names honored) is the final fallback.
//
// The environment fallback is the whole point of the decoupling: a fresh deploy
// with no per-user row still has a working AI path (the operator's default
// connection, e.g. a LiteLLM gateway), and a user who brings their own key
// overrides it for their own requests only.
//
// NO KEY IS EVER HARDCODED HERE. The env var names are configuration points;
// their values live in the deployment's environment, and the seeded per-user
// default is created at runtime from that same environment (see
// `scripts/provision-ai-default.mjs`).
import { db, schema } from "@/lib/db";
import { and, eq, ne } from "drizzle-orm";
import { decryptSecret, encryptSecret, secretLast4 } from "@/lib/crypto/secret-box";
import { logger } from "@/lib/logger";

export interface AiConnectionView {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  /** Masked (`••••1234`) — the plaintext key is never returned. */
  keyLast4: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when this row is a user row (env fallback is surfaced separately). */
  source: "user";
}

export interface ResolvedAiConnection {
  id: string | null;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: "user" | "env";
}

export interface AiConnectionInput {
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export type SaveResult =
  | { ok: true; connection: AiConnectionView }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Shape of a deployment-supplied connection, if one is configured.
 *
 * Read order falls back to the names the deployment already carries so an
 * existing install keeps working without an env change:
 *   AI_BASE_URL   -> FONTO_LLM_BASE_URL
 *   AI_API_KEY    -> FONTO_LLM_KEY
 *   AI_MODEL      -> AI_MODEL (defaults to "auto")
 */
function envConnection(): {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
} | null {
  const baseUrl = (process.env.AI_BASE_URL ?? process.env.FONTO_LLM_BASE_URL ?? "").replace(
    /\/$/,
    ""
  );
  const apiKey = process.env.AI_API_KEY ?? process.env.FONTO_LLM_KEY ?? "";
  const model = process.env.AI_MODEL ?? "auto";
  if (!baseUrl || !apiKey) return null;
  return { label: process.env.AI_LABEL ?? "LiteLLM Auto", baseUrl, apiKey, model };
}

/**
 * True when the deployment supplies a default AI connection through the
 * environment. Used by the settings UI to explain where AI currently resolves.
 */
export function isEnvAiConnectionAvailable(): boolean {
  return envConnection() !== null;
}

/** The deployment-default connection, for callers that need it directly. */
export function deploymentAiConnection(): ResolvedAiConnection | null {
  const conn = envConnection();
  return conn ? { ...conn, id: null, source: "env" } : null;
}

function validate(input: AiConnectionInput): Record<string, string> | null {
  const fieldErrors: Record<string, string> = {};
  const label = input.label.trim();
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  if (label.length < 1 || label.length > 60) fieldErrors.label = "Label must be 1–60 characters.";
  if (!/^https?:\/\//.test(baseUrl))
    fieldErrors.baseUrl = "Base URL must start with http:// or https://.";
  if (baseUrl.length > 500) fieldErrors.baseUrl = "Base URL must be 500 characters or fewer.";
  if (model.length < 1 || model.length > 200) fieldErrors.model = "Model must be 1–200 characters.";
  if (input.apiKey !== undefined) {
    const key = input.apiKey.trim();
    if (key.length > 0 && (key.length < 8 || key.length > 512)) {
      fieldErrors.apiKey = "API key must be 8–512 characters.";
    }
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : null;
}

/** Map a DB row to the UI-facing view. Decrypts only to compute the masked tail. */
function toView(row: {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AiConnectionView {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    keyLast4: secretLast4(row.encryptedApiKey),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: "user",
  };
}

export async function listAiConnections(userId: string): Promise<AiConnectionView[]> {
  const rows = await db
    .select()
    .from(schema.aiConnections)
    .where(eq(schema.aiConnections.userId, userId))
    .orderBy(schema.aiConnections.createdAt);
  return rows.map(toView);
}

/**
 * Create a connection, or update the one with this id when `id` is given.
 * The FIRST connection a user creates becomes their default automatically —
 * otherwise a user could save a connection and have AI still resolve to the
 * env fallback with no visible reason.
 */
export async function saveAiConnection(
  userId: string,
  input: AiConnectionInput & { id?: string; isDefault?: boolean }
): Promise<SaveResult> {
  const fieldErrors = validate(input);
  if (fieldErrors) return { ok: false, error: "Invalid connection.", fieldErrors };

  const label = input.label.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
  const model = input.model.trim();
  const newKey = input.apiKey?.trim() ?? "";

  const existing = await db
    .select({ id: schema.aiConnections.id })
    .from(schema.aiConnections)
    .where(eq(schema.aiConnections.userId, userId));

  const isFirst = existing.length === 0;

  // Editing without a new key keeps the stored one; creating requires one.
  let encryptedApiKey: string | undefined;
  if (newKey) {
    encryptedApiKey = encryptSecret(newKey);
  } else if (!input.id) {
    return {
      ok: false,
      error: "API key is required.",
      fieldErrors: { apiKey: "API key is required." },
    };
  }

  try {
    if (input.id) {
      const [row] = await db
        .update(schema.aiConnections)
        .set({
          label,
          baseUrl,
          model,
          ...(encryptedApiKey ? { encryptedApiKey } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.aiConnections.id, input.id), eq(schema.aiConnections.userId, userId)))
        .returning();
      if (!row) return { ok: false, error: "Connection not found." };
      if (input.isDefault === true) await setDefaultAiConnection(userId, row.id);
      // Re-read so the returned view reflects the default flip above.
      const [fresh] = await db
        .select()
        .from(schema.aiConnections)
        .where(and(eq(schema.aiConnections.id, row.id), eq(schema.aiConnections.userId, userId)));
      return { ok: true, connection: toView(fresh ?? row) };
    }

    const [row] = await db
      .insert(schema.aiConnections)
      .values({
        userId,
        label,
        baseUrl,
        model,
        encryptedApiKey: encryptedApiKey!,
        // First connection becomes the default; an explicit request wins.
        isDefault: input.isDefault ?? isFirst,
      })
      .returning();
    return { ok: true, connection: toView(row) };
  } catch (err) {
    logger.error({ err }, "[ai-connections] save failed");
    return { ok: false, error: "Could not save the connection." };
  }
}

/** Make one connection the user's default, in a single statement pair so two
 * defaults can never coexist (`ai_connections_user_default_idx` enforces it). */
export async function setDefaultAiConnection(
  userId: string,
  connectionId: string
): Promise<boolean> {
  const [target] = await db
    .select({ id: schema.aiConnections.id })
    .from(schema.aiConnections)
    .where(and(eq(schema.aiConnections.id, connectionId), eq(schema.aiConnections.userId, userId)));
  if (!target) return false;
  await db
    .update(schema.aiConnections)
    .set({ isDefault: false })
    .where(and(eq(schema.aiConnections.userId, userId), ne(schema.aiConnections.id, connectionId)));
  await db
    .update(schema.aiConnections)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(and(eq(schema.aiConnections.id, connectionId), eq(schema.aiConnections.userId, userId)));
  return true;
}

export async function deleteAiConnection(userId: string, connectionId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.aiConnections)
    .where(and(eq(schema.aiConnections.id, connectionId), eq(schema.aiConnections.userId, userId)))
    .returning({ id: schema.aiConnections.id, wasDefault: schema.aiConnections.isDefault });
  const deleted = rows[0];
  if (!deleted) return false;
  // Promote another connection so the user is never silently left on the env
  // fallback after deleting the default.
  if (deleted.wasDefault) {
    const [next] = await db
      .select({ id: schema.aiConnections.id })
      .from(schema.aiConnections)
      .where(eq(schema.aiConnections.userId, userId))
      .orderBy(schema.aiConnections.createdAt);
    if (next) await setDefaultAiConnection(userId, next.id);
  }
  return true;
}

/**
 * Resolve the connection an inference call should use, in order:
 *   1. the named connection (when the caller knows which one it wants),
 *   2. the user's own default,
 *   3. the deployment's env-supplied connection.
 * Returns null when the user has nothing configured and the deployment has no
 * env connection — callers degrade to a typed non-AI result, never a 503.
 */
export async function resolveAiConnection(
  userId?: string | null,
  opts: { connectionId?: string | null } = {}
): Promise<ResolvedAiConnection | null> {
  if (userId) {
    const rows = await db
      .select()
      .from(schema.aiConnections)
      .where(eq(schema.aiConnections.userId, userId))
      .orderBy(schema.aiConnections.createdAt);

    const chosen = opts.connectionId
      ? rows.find((r) => r.id === opts.connectionId)
      : (rows.find((r) => r.isDefault) ?? rows[0]);

    if (chosen) {
      try {
        return {
          id: chosen.id,
          label: chosen.label,
          baseUrl: chosen.baseUrl,
          apiKey: decryptSecret(chosen.encryptedApiKey),
          model: chosen.model,
          source: "user",
        };
      } catch (err) {
        // A row whose ciphertext cannot be decrypted (rotated AUTH_SECRET)
        // must not be used silently; fall through to the env connection.
        logger.warn(
          { err, connectionId: chosen.id },
          "[ai-connections] decrypt failed — falling through to the deployment default"
        );
      }
    }
  }

  const envConn = envConnection();
  if (envConn) return { ...envConn, id: null, source: "env" };
  return null;
}

/**
 * Resolve the connection for a request that MUST NOT fail: when nothing is
 * configured at all, return null and let the caller return a typed
 * "AI not configured" result. Exists as a named helper so the reason is
 * explicit at each call site.
 */
export async function resolveAiConnectionOrNull(
  userId?: string | null
): Promise<ResolvedAiConnection | null> {
  try {
    return await resolveAiConnection(userId);
  } catch (err) {
    logger.warn({ err }, "[ai-connections] resolution failed");
    return null;
  }
}
